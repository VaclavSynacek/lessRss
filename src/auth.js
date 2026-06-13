'use strict';

const crypto = require('node:crypto');

function configuredUser() {
  return process.env.GREADER_USER || process.env.LESSRSS_USER || 'alice';
}

function configuredPassword() {
  return process.env.GREADER_PASSWORD || process.env.LESSRSS_PASSWORD || 'secret';
}

function secret() {
  return process.env.LESSRSS_AUTH_SECRET || process.env.GREADER_PASSWORD || process.env.LESSRSS_PASSWORD || 'dev-secret';
}

function authTokenFor(user) {
  return crypto.createHmac('sha256', secret()).update('auth:' + user).digest('hex');
}

function postTokenFor(user) {
  return crypto.createHmac('sha256', secret()).update('post:' + user).digest('hex');
}

function loginResponse(user) {
  const auth = `${user}/${authTokenFor(user)}`;
  return `SID=${auth}\nLSID=null\nAuth=${auth}\n`;
}

function validateLogin(email, password) {
  return email === configuredUser() && password === configuredPassword();
}

function parseAuthHeader(value) {
  const m = /^GoogleLogin\s+auth=(.+)$/.exec(value || '');
  if (!m) return null;
  const auth = m[1];
  const slash = auth.indexOf('/');
  if (slash < 1) return null;
  return { user: auth.slice(0, slash), token: auth.slice(slash + 1), auth };
}

function validateAuthHeader(value) {
  const parsed = parseAuthHeader(value);
  if (!parsed) return null;
  if (parsed.user !== configuredUser()) return null;
  if (parsed.token !== authTokenFor(parsed.user)) return null;
  return parsed;
}

module.exports = {
  configuredUser,
  configuredPassword,
  authTokenFor,
  postTokenFor,
  loginResponse,
  validateLogin,
  validateAuthHeader,
};
