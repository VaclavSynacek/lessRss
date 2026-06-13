'use strict';

const { CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { documentClient, tableName } = require('../src/dynamodb-client');

async function main() {
  const ddb = documentClient();
  const TableName = tableName();
  try {
    await ddb.send(new DescribeTableCommand({ TableName }));
    console.log(`DynamoDB table already exists: ${TableName}`);
    return;
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }

  await ddb.send(new CreateTableCommand({
    TableName,
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  }));
  console.log(`Created DynamoDB table: ${TableName}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
