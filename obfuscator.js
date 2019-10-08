// obfuscate ip addresses which should not be stored long-term.

var SDPUtils = require('sdp');

function Obfuscator() {
}

// obfuscate ip, keeping address family intact.
Obfuscator.prototype.obfuscateIP = function (ip) {
  if (ip.indexOf('[') === 0 || ip.indexOf(':') !== -1) { // IPv6
    return '::1';
  }
  var parts = ip.split('.');
  if (parts.length === 4) {
    parts[3] = 'x';
    return parts.join('.');
  } else {
    return ip;
  }
};

// obfuscate the ip in ice candidates. Does NOT obfuscate the ip of the TURN server to allow
// selecting/grouping sessions by TURN server.
Obfuscator.prototype.obfuscateCandidate = function (candidate) {
  var cand = SDPUtils.parseCandidate(candidate);
  if (cand.type !== 'relay') {
    cand.ip = this.obfuscateIP(cand.ip);
    cand.address = this.obfuscateIP(cand.address);
  }
  if (cand.relatedAddress) {
    cand.relatedAddress = this.obfuscateIP(cand.relatedAddress);
  }
  return SDPUtils.writeCandidate(cand);
};

Obfuscator.prototype.obfuscateSDP = function (sdp) {
  var self = this;
  var lines = SDPUtils.splitLines(sdp);
  return lines.map(function (line) {
    // obfuscate a=candidate, c= and a=rtcp
    if (line.indexOf('a=candidate:') === 0) {
      return self.obfuscateCandidate(line);
    } else if (line.indexOf('c=') === 0) {
      return 'c=IN IP4 0.0.0.0';
    } else if (line.indexOf('a=rtcp:') === 0) {
      return 'a=rtcp:9 IN IP4 0.0.0.0';
    } else {
      return line;
    }
  }).join('\r\n').trim() + '\r\n';
};

Obfuscator.prototype.obfuscateStats = function (stats) {
  var self = this;
  Object.keys(stats).forEach(function (id) {
    var report = stats[id];
    if (report.ipAddress && report.candidateType !== 'relayed') {
      report.ipAddress = self.obfuscateIP(report.ipAddress);
    }
    ['googLocalAddress', 'googRemoteAddress'].forEach(function (name) {
      // contains both address and port
      var address = report[name];
      if (address) {
        var portSeperator = address.lastIndexOf(':');
        var ip = address.substr(0, portSeperator);
        var port = address.substr(portSeperator + 1);
        if (ip.startsWith('[') && ip.endsWith(']')) {
          var innerIP = ip.substr(1, ip.length - 2);
          ip = '[' + self.obfuscateIP(innerIP) + ']';
        } else {
          ip = self.obfuscateIP(ip);
        }
        report[name] = ip + ':' + port;
      }
    });
  });
};

Obfuscator.prototype.obfuscate = function (eventName, details) {
  switch (eventName) {
    case 'addIceCandidate':
    case 'onicecandidate':
      if (details && details.candidate) {
        details.candidate = this.obfuscateCandidate(details.candidate);
      }
      break;
    case 'setLocalDescription':
    case 'setRemoteDescription':
    case 'createOfferOnSuccess':
    case 'createAnswerOnSuccess':
      if (details && details.sdp) {
        details.sdp = this.obfuscateSDP(details.sdp);
      }
      break;
    case 'getStats':
    case 'getstats':
      if (details) {
        this.obfuscateStats(details);
      }
      break;
    default:
      break;
  }
  return details;
};

var defaultObfuscator = new Obfuscator();

module.exports = function (data) {
  return defaultObfuscator.obfuscate(data[0], data[2]);
};

module.exports.Obfuscator = Obfuscator;
