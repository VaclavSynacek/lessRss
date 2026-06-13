'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

function tableName() {
  return process.env.LESSRSS_DDB_TABLE || 'lessrss-local';
}

function documentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.AWS_ENDPOINT_URL_DYNAMODB || '';
  const cfg = {
    region: process.env.AWS_REGION || 'local',
  };
  if (endpoint) {
    cfg.endpoint = endpoint;
    cfg.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'dummy',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'dummy',
    };
  }
  return DynamoDBDocumentClient.from(new DynamoDBClient(cfg), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

module.exports = { documentClient, tableName };
