require('dotenv').config();
const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({
  region: 'eu-central-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const docClient = DynamoDBDocumentClient.from(client);

const TABLES = [
  'bm-categories',
  'bm-products',
  'bm-task-lists',
  'bm-employees',
  'bm-schedules',
  'bm-reminders',
  'bm-backups'
];

async function main() {
  console.log('='.repeat(50));
  console.log('DynamoDB Verification');
  console.log('='.repeat(50) + '\n');

  for (const tableName of TABLES) {
    try {
      // Count all items by scanning
      let count = 0;
      let lastKey = undefined;
      do {
        const scanResult = await docClient.send(new ScanCommand({
          TableName: tableName,
          Select: 'COUNT',
          ExclusiveStartKey: lastKey
        }));
        count += scanResult.Count;
        lastKey = scanResult.LastEvaluatedKey;
      } while (lastKey);

      // Get sample item
      const sampleResult = await docClient.send(new ScanCommand({
        TableName: tableName,
        Limit: 1
      }));

      console.log(`${tableName}:`);
      console.log(`  Items: ${count}`);
      if (sampleResult.Items.length > 0) {
        const keys = Object.keys(sampleResult.Items[0]);
        console.log(`  Sample keys: ${keys.join(', ')}`);
      }
      console.log('');
    } catch (err) {
      console.log(`${tableName}: ERROR - ${err.message}\n`);
    }
  }
}

main();
