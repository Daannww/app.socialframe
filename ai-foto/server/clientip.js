// Echt IP van de bezoeker. Achter Cloudflare is req.ip het IP van Cloudflare zelf; het echte IP staat in
// CF-Connecting-IP. Die header vertrouwen we alléén als het verzoek echt van een Cloudflare-adres komt
// (anders kan iedereen de header zelf meesturen om de limiet te omzeilen).
const net = require('net');
const CF4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

function v4ToInt(ip) { return ip.split('.').reduce((a, o) => (a * 256) + parseInt(o, 10), 0); }
function v6ToBig(ip) {
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}
function inCidr(ip, cidr) {
  const [base, bitsS] = cidr.split('/'), bits = parseInt(bitsS, 10);
  if (net.isIPv4(ip) && net.isIPv4(base)) { const sh = 32 - bits; return Math.floor(v4ToInt(ip) / 2 ** sh) === Math.floor(v4ToInt(base) / 2 ** sh); }
  if (net.isIPv6(ip) && net.isIPv6(base)) { const sh = BigInt(128 - bits); return (v6ToBig(ip) >> sh) === (v6ToBig(base) >> sh); }
  return false;
}
function isCloudflare(ip) {
  const x = String(ip || '').replace(/^::ffff:/, '');
  return (net.isIPv4(x) ? CF4 : net.isIPv6(x) ? CF6 : []).some((c) => inCidr(x, c));
}
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && net.isIP(cf) && isCloudflare(req.ip)) return cf;
  return req.ip;
}
module.exports = { clientIp, isCloudflare };
