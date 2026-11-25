'use strict';

const crypto = require('node:crypto');

function required(name, alias) {
  const value = process.env[name] || (alias && process.env[alias]);
  if (!value || !value.trim()) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

const user = required('GREADER_USER', 'LESSRSS_USER');
const password = required('GREADER_PASSWORD', 'LESSRSS_PASSWORD');
const signingSecret = required('LESSRSS_AUTH_SECRET');

function configuredUser() {
  return user;
}

function configuredPassword() {
  return password;
}

function secret() {
  return signingSecret;
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
