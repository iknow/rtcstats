'use strict';

var isFirefox = !!window.mozRTCPeerConnection;
var isEdge = !!window.RTCIceGatherer;

// Utils

function deepCopyJSON(x) {
  return JSON.parse(JSON.stringify(x));
}

// transforms a maplike to an object. Mostly for getStats +
// JSON.parse(JSON.stringify())
function map2obj(m) {
  if (!m.entries) {
    return m;
  }
  var o = {};
  m.forEach(function(v, k) {
    o[k] = v;
  });
  return o;
}

// Compression

// apply a delta compression to the stats report. Reduces size by ~90%.
// To reduce further, report keys could be compressed.
function deltaCompression(oldStats, newStats) {
  newStats = deepCopyJSON(newStats);
  Object.keys(newStats).forEach(function(id) {
    if (!oldStats[id]) {
      return;
    }
    var report = newStats[id];
    Object.keys(report).forEach(function(name) {
      if (report[name] === oldStats[id][name]) {
        delete newStats[id][name];
      }
      delete report.timestamp;
      if (Object.keys(report).length === 0) {
        delete newStats[id];
      }
    });
  });
  // TODO: moving the timestamp to the top-level is not compression but...
  newStats.timestamp = new Date();
  return newStats;
}

// Inspection

function dumpTrack(track) {
  return {
    id: track.id,                 // unique identifier (GUID) for the track
    kind: track.kind,             // `audio` or `video`
    label: track.label,           // identified the track source
    enabled: track.enabled,       // application can control it
    muted: track.muted,           // application cannot control it (read-only)
    readyState: track.readyState, // `live` or `ended`
  };
}
function dumpStream(stream) {
  return {
    id: stream.id,
    tracks: stream.getTracks().map(dumpTrack),
  };
}

var inspectors = {
  MediaStream: dumpStream,

  RTCPeerConnectionIceEvent: function(e) {
    return e.candidate;
  },

  RTCTrackEvent: function(e) {
    return dumpTrack(e.track);
  },

  MediaStreamEvent: function(e) {
    return dumpStream(e.stream);
  },

  Object: function(o) {
    return o;
  }
};

function inspect(x) {
  if (x !== null && typeof x === 'object') {
    var typeName = x.constructor.name;
    var inspector = inspectors[typeName];
    return inspector ? inspector(x) : x;
  }
  return x;
}

// Output

function websocketTrace(url) {
  var PROTOCOL_VERSION = '1.0';
  var buffer = [];
  var connection = new WebSocket(url + window.location.pathname, PROTOCOL_VERSION);
  connection.onerror = function(e) {
    console.log('WS ERROR', e);
  };

  connection.onopen = function() {
    while (buffer.length) {
      connection.send(JSON.stringify(buffer.shift()));
    }
  };

  function trace() {
    var args = Array.prototype.slice.call(arguments);
    args.push(new Date().getTime());
    if (connection.readyState === 1) {
      connection.send(JSON.stringify(args));
    } else {
      buffer.push(args);
    }
  }

  return trace;
}

// Method wrapping

function traceMethod(trace, object, method, name) {
  var native = object[method];
  if (!native) return;
  if (!name) name = method;
  object[method] = function() {
    var args = Array.prototype.slice.call(arguments).map(inspect);
    if (args.length === 0) {
      args = undefined;
    } else if (args.length === 1) {
      args = args[0];
    }
    trace(name, args);
    var returnValue = native.apply(this, arguments);
    if (returnValue !== null && typeof returnValue === 'object' && 'then' in returnValue) {
      returnValue.then(
        function (value) { trace(name + 'OnSuccess', inspect(value)); },
        function (failure) { trace(name + 'OnFailure', inspect(failure)); }
      );
    }
    return returnValue;
  };
}

function traceEvent(trace, object, event, eventInspector) {
  eventInspector = eventInspector || inspect;
  var reportedEventName = 'on' + event;
  object.addEventListener(event, function(e) {
    trace(reportedEventName, eventInspector(e));
  });
}

function traceStateChangeEvent(trace, object, stateKey) {
  var changeEventName = stateKey.toLowerCase() + 'change';
  var reportedEventName = 'on' + changeEventName;
  object.addEventListener(changeEventName, function () {
    trace(reportedEventName, object[stateKey]);
  });
}

function tracePeerConnection(pc, options) {
  var config = options.config || { nullConfig: true };
  var constraints = options.constraints;
  var trace = options.trace;
  var getStatsInterval = options.getStatsInterval;

  if (!config) {
    config = { nullConfig: true };
  }

  config = deepCopyJSON(config); // deepcopy
  // don't log credentials
  ((config && config.iceServers) || []).forEach(function(server) {
    delete server.credential;
  });

  if (isFirefox) {
    config.browserType = 'moz';
  } else if (isEdge) {
    config.browserType = 'edge';
  } else {
    config.browserType = 'webkit';
  }

  trace('create', config);

  // TODO: do we want to log constraints here? They are chrome-proprietary.
  // http://stackoverflow.com/questions/31003928/what-do-each-of-these-experimental-goog-rtcpeerconnectionconstraints-do
  if (constraints) {
    trace('constraints', constraints);
  }

  [
    'createDataChannel', 'close',
    'addTrack', 'removeTrack',
    'addStream', 'removeStream',
    'createOffer', 'createAnswer',
    'setLocalDescription', 'setRemoteDescription',
    'addIceCandidate'
  ].forEach(function (method) {
    traceMethod(trace, pc, method);
  });

  [
    'addstream', 'removestream',
    'track',
    'negotiationneeded',
    'datachannel'
  ].forEach(function (event) {
    traceEvent(trace, pc, event);
  });

  // Safari's RTCPeerConnectionIceEvent doesn't seem to have an appropriate constructor
  traceEvent(trace, pc, 'icecandidate', inspectors.RTCPeerConnectionIceEvent);

  [
    'connectionState',
    'signalingState',
    'iceConnectionState',
    'iceGatheringState',
  ].forEach(function (event) {
    traceStateChangeEvent(trace, pc, event);
  });

  // TODO: do we want one big interval and all peerconnections
  //    queried in that or one setInterval per PC?
  //    we have to collect results anyway so...
  if (!isEdge) {
    var prev = {};
    var interval = window.setInterval(function() {
      if (pc.signalingState === 'closed') {
        window.clearInterval(interval);
        return;
      }

      pc.getStats().then(function (stats) {
        var now = map2obj(stats);
        trace('getstats', deltaCompression(prev, now));
        prev = now;
      });
    }, getStatsInterval);
  }
  return pc;
}

function traceGlobally(wsURL, getStatsInterval, prefixesToWrap) {
  var wstrace = websocketTrace(wsURL);

  var peerconnectioncounter = 0;
  prefixesToWrap.forEach(function(prefix) {
    if (!window[prefix + 'RTCPeerConnection']) {
      return;
    }
    if (prefix === 'webkit' && isEdge) {
      // dont wrap webkitRTCPeerconnection in Edge.
      // TODO: why?
      return;
    }
    var origPeerConnection = window[prefix + 'RTCPeerConnection'];
    var peerconnection = function(config, constraints) {
      var id = 'PC_' + peerconnectioncounter++;
      var pc = new origPeerConnection(config, constraints);
      tracePeerConnection(pc, {
        config: config,
        constraints: constraints,
        trace: function(eventName, details) {
          wstrace(eventName, id, details);
        },
        getStatsInterval: getStatsInterval
      });
      return pc; // Note overriding return value of constructor function as per ECMA 262 9.2.2
    };

    // Copy static methods to replaced constructor
    [
      'generateCertificate',
    ].forEach(function (method) {
      if (origPeerConnection[method]) {
        peerconnection[method] = origPeerConnection[method];
      }
    });

    // This prototype isn't going to be used for method resolution, since the constructor returns an
    // instance of the original type. However, it's still used by code that expects to be able to
    // inspect and manipulate the prototype via `RTCPeerConnection.prototype` (like webrtc-adapter).
    peerconnection.prototype = origPeerConnection.prototype;

    window[prefix + 'RTCPeerConnection'] = peerconnection;
  });

  prefixesToWrap.forEach(function(prefix) {
    traceMethod(wstrace, navigator,
      prefix + (prefix.length ? 'GetUserMedia' : 'getUserMedia'));
  });

  traceMethod(wstrace, navigator.mediaDevices, 'getUserMedia',
    'navigator.mediaDevices.getUserMedia');

  // Export trace method into global namespace for interactive debugging
  window.rtcstats = { trace: wstrace };
}

module.exports = traceGlobally;
module.exports.tracePeerConnection = tracePeerConnection;
