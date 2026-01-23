require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

// Configure AWS
const client = new DynamoDBClient({
  region: 'eu-central-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const docClient = DynamoDBDocumentClient.from(client);

const TABLES = {
  categories: {
    TableName: 'bm-categories',
    KeySchema: [
      { AttributeName: 'locationId', KeyType: 'HASH' },
      { AttributeName: 'categoryId', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'locationId', AttributeType: 'S' },
      { AttributeName: 'categoryId', AttributeType: 'S' }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  },
  products: {
    TableName: 'bm-products',
    KeySchema: [
      { AttributeName: 'locationId', KeyType: 'HASH' },
      { AttributeName: 'productId', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'locationId', AttributeType: 'S' },
      { AttributeName: 'productId', AttributeType: 'S' },
      { AttributeName: 'categoryId', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [{
      IndexName: 'categoryId-index',
      KeySchema: [{ AttributeName: 'categoryId', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' }
    }],
    BillingMode: 'PAY_PER_REQUEST'
  },
  taskLists: {
    TableName: 'bm-task-lists',
    KeySchema: [
      { AttributeName: 'locationId', KeyType: 'HASH' },
      { AttributeName: 'listId', KeyType: 'RANGE' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'locationId', AttributeType: 'S' },
      { AttributeName: 'listId', AttributeType: 'S' }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  },
  employees: {
    TableName: 'bm-employees',
    KeySchema: [
      { AttributeName: 'employeeId', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'employeeId', AttributeType: 'S' }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  },
  schedules: {
    TableName: 'bm-schedules',
    KeySchema: [
      { AttributeName: 'weekId', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'weekId', AttributeType: 'S' }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  },
  reminders: {
    TableName: 'bm-reminders',
    KeySchema: [
      { AttributeName: 'reminderId', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'reminderId', AttributeType: 'S' }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  },
  backups: {
    TableName: 'bm-backups',
    KeySchema: [
      { AttributeName: 'backupId', KeyType: 'HASH' }
    ],
    AttributeDefinitions: [
      { AttributeName: 'backupId', AttributeType: 'S' }
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: {
      AttributeName: 'ttl',
      Enabled: true
    }
  }
};

async function tableExists(tableName) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function createTable(tableConfig) {
  const { TimeToLiveSpecification, ...createParams } = tableConfig;

  if (await tableExists(tableConfig.TableName)) {
    console.log(`  Table ${tableConfig.TableName} already exists, skipping...`);
    return;
  }

  console.log(`  Creating table ${tableConfig.TableName}...`);
  await client.send(new CreateTableCommand(createParams));

  // Wait for table to be active
  await waitUntilTableExists(
    { client, maxWaitTime: 120 },
    { TableName: tableConfig.TableName }
  );
  console.log(`  Table ${tableConfig.TableName} created successfully`);
}

async function batchWriteItems(tableName, items) {
  // DynamoDB batch write supports max 25 items at once
  const batches = [];
  for (let i = 0; i < items.length; i += 25) {
    batches.push(items.slice(i, i + 25));
  }

  for (const batch of batches) {
    const putRequests = batch.map(item => ({
      PutRequest: { Item: item }
    }));

    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: putRequests
      }
    }));
  }
}

async function importData() {
  console.log('\n' + '='.repeat(50));
  console.log('Importing Data to DynamoDB');
  console.log('='.repeat(50) + '\n');

  const exportsDir = path.join(__dirname, 'exports');

  // Import locations (categories, products, task lists)
  for (const location of ['isgav', 'frankfurt']) {
    const filePath = path.join(exportsDir, `location-${location}.json`);
    if (!fs.existsSync(filePath)) {
      console.log(`  Skipping ${location} - file not found`);
      continue;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`\nImporting ${location} data...`);

    // Categories
    const categories = (data.categories || []).map((cat, index) => ({
      locationId: location,
      categoryId: String(cat.id),
      name: cat.name,
      sortOrder: index
    }));

    if (categories.length > 0) {
      await batchWriteItems('bm-categories', categories);
      console.log(`  -> Imported ${categories.length} categories`);
    }

    // Products (flattened from categories)
    const products = [];
    for (const cat of (data.categories || [])) {
      for (const prod of (cat.products || [])) {
        products.push({
          locationId: location,
          productId: String(prod.id),
          categoryId: String(cat.id),
          name: prod.name,
          quantity: prod.quantity || 0,
          unit: prod.unit || 'item'
        });
      }
    }

    if (products.length > 0) {
      await batchWriteItems('bm-products', products);
      console.log(`  -> Imported ${products.length} products`);
    }

    // Task Lists
    const taskLists = (data.taskLists || []).map(list => ({
      locationId: location,
      listId: String(list.id),
      name: list.name,
      color: list.color || 'blue',
      tasks: list.tasks || []
    }));

    if (taskLists.length > 0) {
      await batchWriteItems('bm-task-lists', taskLists);
      console.log(`  -> Imported ${taskLists.length} task lists`);
    }
  }

  // Import employee schedules
  const schedulesPath = path.join(exportsDir, 'employee-schedules.json');
  if (fs.existsSync(schedulesPath)) {
    const schedulesData = JSON.parse(fs.readFileSync(schedulesPath, 'utf-8'));
    console.log('\nImporting employee schedules...');

    // Extract config (employees + shift hours)
    if (schedulesData.config) {
      // Import employees
      const employees = (schedulesData.config.employees || []).map(emp => ({
        employeeId: String(emp.id),
        name: emp.name,
        phone: emp.phone
      }));

      if (employees.length > 0) {
        await batchWriteItems('bm-employees', employees);
        console.log(`  -> Imported ${employees.length} employees`);
      }

      // Import config as a schedule entry
      await docClient.send(new PutCommand({
        TableName: 'bm-schedules',
        Item: {
          weekId: 'config',
          shiftHours: schedulesData.config.shiftHours
        }
      }));
      console.log('  -> Imported shift hours config');
    }

    // Import weekly schedules
    const weeklySchedules = [];
    for (const [weekId, schedule] of Object.entries(schedulesData)) {
      if (weekId === 'config') continue;
      weeklySchedules.push({
        weekId: weekId,
        weekStart: schedule.weekStart || weekId,
        availability: schedule.availability || {},
        finalSchedule: schedule.finalSchedule
      });
    }

    if (weeklySchedules.length > 0) {
      await batchWriteItems('bm-schedules', weeklySchedules);
      console.log(`  -> Imported ${weeklySchedules.length} weekly schedules`);
    }
  }

  // Import reminders
  const remindersPath = path.join(exportsDir, 'reminders.json');
  if (fs.existsSync(remindersPath)) {
    const remindersData = JSON.parse(fs.readFileSync(remindersPath, 'utf-8'));
    console.log('\nImporting reminders...');

    const reminders = Object.entries(remindersData).map(([id, reminder]) => ({
      reminderId: id,
      title: reminder.title,
      time: reminder.time,
      type: reminder.type,
      enabled: reminder.enabled,
      days: reminder.days || [],
      date: reminder.date || null,
      createdAt: reminder.createdAt ? new Date(reminder.createdAt._seconds * 1000).toISOString() : new Date().toISOString()
    }));

    if (reminders.length > 0) {
      await batchWriteItems('bm-reminders', reminders);
      console.log(`  -> Imported ${reminders.length} reminders`);
    }
  }

  // Import backups (with TTL for auto-deletion after 90 days)
  const backupsPath = path.join(exportsDir, 'backups.json');
  if (fs.existsSync(backupsPath)) {
    const backupsData = JSON.parse(fs.readFileSync(backupsPath, 'utf-8'));
    console.log('\nImporting backups...');

    const now = Math.floor(Date.now() / 1000);
    const ninetyDaysInSeconds = 90 * 24 * 60 * 60;

    const backups = Object.entries(backupsData).map(([id, backup]) => ({
      backupId: id,
      location: backup.location || 'unknown',
      categories: backup.categories || [],
      taskLists: backup.taskLists || [],
      backupTime: backup.backupTime || new Date().toISOString(),
      ttl: now + ninetyDaysInSeconds
    }));

    // Import in smaller batches due to large item sizes
    console.log(`  -> Importing ${backups.length} backups (this may take a while)...`);
    let imported = 0;
    for (const backup of backups) {
      try {
        await docClient.send(new PutCommand({
          TableName: 'bm-backups',
          Item: backup
        }));
        imported++;
        if (imported % 50 === 0) {
          console.log(`     Progress: ${imported}/${backups.length}`);
        }
      } catch (err) {
        console.log(`     Warning: Failed to import backup ${backup.backupId}: ${err.message}`);
      }
    }
    console.log(`  -> Imported ${imported} backups`);
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('DynamoDB Setup Script');
  console.log('='.repeat(50));
  console.log('\nCreating tables...\n');

  try {
    // Create all tables
    for (const [name, config] of Object.entries(TABLES)) {
      await createTable(config);
    }

    // Import data
    await importData();

    console.log('\n' + '='.repeat(50));
    console.log('Setup complete!');
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

main();
