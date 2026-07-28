'use strict';

async function dispatchCrawl() {
  const functionName = process.env.LESSRSS_CRAWLER_FUNCTION || '';
  if (!functionName) {
    setImmediate(() => {
      const { handler } = require('./crawler-handler');
      handler({ source: 'lessrss.opml-import' }).catch((e) => {
        console.error('subscription/import: local crawler failed', e);
      });
    });
    return { mode: 'local' };
  }

  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const client = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const result = await client.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ source: 'lessrss.opml-import' })),
  }));
  if (result.StatusCode !== 202) throw new Error(`crawler invocation returned HTTP ${result.StatusCode || 0}`);
  return { mode: 'lambda', statusCode: result.StatusCode };
}

module.exports = { dispatchCrawl };
