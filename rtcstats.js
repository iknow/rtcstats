'use strict';

var isFirefox = !!window.mozRTCPeerConnection;
var isEdge = !!window.RTCIceGatherer;

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

// apply a delta compression to the stats report. Reduces size by ~90%.
// To reduce further, report keys could be compressed.
function deltaCompression(oldStats, newStats) {
  newStats = JSON.parse(JSON.stringify(newStats));
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

/*
function filterBoringStats(results) {
  Object.keys(results).forEach(function(id) {
    switch (results[id].type) {
      case 'certificate':
      case 'codec':
        delete results[id];
        break;
      default:
        // noop
    }
  });
  return results;
}

function removeTimestamps(results) {
  // FIXME: does not work in FF since the timestamp can't be deleted.
  Object.keys(results).forEach(function(id) {
    delete results[id].timestamp;
  });
  return results;
}
*/

var inspectors = {
  MediaStream: function(stream) {
    var streamInfo = stream.getTracks().map(function(t) {
      return t.kind + ':' + t.id;
    });

    return stream.id + ' ' + streamInfo;
  },

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

function traceMethod(trace, object, method) {
  var native = object[method];
  if (!native) return;
  object[method] = function() {
    var args = Array.prototype.slice.call(arguments).map(inspect);
    if (args.length === 0) {
      args = undefined;
    } else if (args.length === 1) {
      args = args[0];
    }
    trace(method, args);
    var returnValue = native.apply(this, arguments);
    if (returnValue !== null && typeof returnValue === 'object' && 'then' in returnValue) {
      returnValue.then(
        function (value) { trace(method + 'OnSuccess', inspect(value)); },
        function (failure) { trace(method + 'OnFailure', inspect(failure)); }
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

function instrumentPeerConnection(pc, options) {
  var config = options.config || { nullConfig: true };
  var constraints = options.constraints;
  var trace = options.trace;
  var getStatsInterval = options.getStatsInterval;

  if (!config) {
    config = { nullConfig: true };
  }

  config = JSON.parse(JSON.stringify(config)); // deepcopy
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
        var base = JSON.parse(JSON.stringify(now)); // our new prev
        trace('getstats', deltaCompression(prev, now));
        prev = base;
      });
    }, getStatsInterval);
  }
  return pc;
}

function instrumentGlobally(wsURL, getStatsInterval, prefixesToWrap) {
  var PROTOCOL_VERSION = '1.0';
  var buffer = [];
  var connection = new WebSocket(wsURL + window.location.pathname, PROTOCOL_VERSION);
  connection.onerror = function(e) {
    console.log('WS ERROR', e);
  };

  /*
  connection.onclose = function() {
    // reconnect?
  };
  */

  connection.onopen = function() {
    while (buffer.length) {
      connection.send(JSON.stringify(buffer.shift()));
    }
  };

  /*
  connection.onmessage = function(msg) {
    // no messages from the server defined yet.
  };
  */

  function trace() {
    //console.log.apply(console, arguments);
    // TODO: drop getStats when not connected?
    var args = Array.prototype.slice.call(arguments);
    args.push(new Date().getTime());
    if (connection.readyState === 1) {
      connection.send(JSON.stringify(args));
    } else {
      buffer.push(args);
    }
  }

  var peerconnectioncounter = 0;
  prefixesToWrap.forEach(function(prefix) {
    if (!window[prefix + 'RTCPeerConnection']) {
      return;
    }
    if (prefix === 'webkit' && isEdge) {
      // dont wrap webkitRTCPeerconnection in Edge.
      return;
    }
    var origPeerConnection = window[prefix + 'RTCPeerConnection'];
    var peerconnection = function(config, constraints) {
      var id = 'PC_' + peerconnectioncounter++;
      var pc = new origPeerConnection(config, constraints);
      instrumentPeerConnection(pc, {
        config: config,
        constraints: constraints,
        trace: function(eventName, details) {
          trace(eventName, id, details);
        },
        getStatsInterval: getStatsInterval
      });
      return pc;
    };
    // wrap static methods. Currently just generateCertificate.
    if (origPeerConnection.generateCertificate) {
      Object.defineProperty(peerconnection, 'generateCertificate', {
        get: function() {
          return arguments.length ?
              origPeerConnection.generateCertificate.apply(null, arguments)
              : origPeerConnection.generateCertificate;
        },
      });
    }
    window[prefix + 'RTCPeerConnection'] = peerconnection;
    window[prefix + 'RTCPeerConnection'].prototype = origPeerConnection.prototype;
  });

  // getUserMedia wrappers
  prefixesToWrap.forEach(function(prefix) {
    var name = prefix + (prefix.length ? 'GetUserMedia' : 'getUserMedia');
    if (!navigator[name]) {
      return;
    }
    var origGetUserMedia = navigator[name].bind(navigator);
    var gum = function() {
      trace('getUserMedia', null, arguments[0]);
      var cb = arguments[1];
      var eb = arguments[2];
      origGetUserMedia(arguments[0],
        function(stream) {
          // we log the stream id, track ids and tracks readystate since that is ended GUM fails
          // to acquire the cam (in chrome)
          trace('getUserMediaOnSuccess', null, dumpStream(stream));
          if (cb) {
            cb(stream);
          }
        },
        function(err) {
          trace('getUserMediaOnFailure', null, err.name);
          if (eb) {
            eb(err);
          }
        }
      );
    };
    navigator[name] = gum.bind(navigator);
  });

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    var gum = function() {
      trace('navigator.mediaDevices.getUserMedia', null, arguments[0]);
      return origGetUserMedia.apply(navigator.mediaDevices, arguments)
      .then(function(stream) {
        trace('navigator.mediaDevices.getUserMediaOnSuccess', null, dumpStream(stream));
        return stream;
      }, function(err) {
        trace('navigator.mediaDevices.getUserMediaOnFailure', null, err.name);
        return Promise.reject(err);
      });
    };
    navigator.mediaDevices.getUserMedia = gum.bind(navigator.mediaDevices);
  }

  // TODO: are there events defined on MST that would allow us to listen when enabled was set?
  //    no :-(
  /*
  Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
    set: function(value) {
      trace('MediaStreamTrackEnable', this, value);
    }
  });
  */

  window.rtcstats = {
    trace: trace,
  };
}

module.exports = instrumentGlobally;
module.exports.instrumentPeerConnection = instrumentPeerConnection;
