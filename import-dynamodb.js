/**
 * Import data from Firebase exports to DynamoDB
 *
 * This script reads the JSON files exported from Firebase
 * and imports them into DynamoDB tables.
 *
 * Prerequisites:
 * 1. Run export-firebase.js first to export data
 * 2. Set up AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 3. Run: npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb dotenv
 *
 * Usage:
 *   node import-dynamodb.js
 */

require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

// Configure AWS
const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'eu-central-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const docClient = DynamoDBDocumentClient.from(client);

// Table configuration (matches Lambda function)
const TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX || 'business-manager';
const TABLES = {
    locations: {
        TableName: `${TABLE_PREFIX}-locations`,
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST'
    },
    schedules: {
        TableName: `${TABLE_PREFIX}-schedules`,
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST'
    },
    reminders: {
        TableName: `${TABLE_PREFIX}-reminders`,
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST'
    },
    backups: {
        TableName: `${TABLE_PREFIX}-backups`,
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST'
    }
};

// Helper functions
async function tableExists(tableName) {
    try {
        await client.send(new DescribeTableCommand({ TableName: tableName }));
        return true;
    } catch (err) {
        if (err.name === 'ResourceNotFoundException') return false;
        throw err;
    }
}

async function createTableIfNotExists(tableConfig) {
    if (await tableExists(tableConfig.TableName)) {
        console.log(`  Table ${tableConfig.TableName} already exists`);
        return;
    }

    console.log(`  Creating table ${tableConfig.TableName}...`);
    await client.send(new CreateTableCommand(tableConfig));

    await waitUntilTableExists(
        { client, maxWaitTime: 120 },
        { TableName: tableConfig.TableName }
    );
    console.log(`  Table ${tableConfig.TableName} created`);
}

async function putItem(tableName, item) {
    await docClient.send(new PutCommand({
        TableName: tableName,
        Item: item
    }));
}

// Import functions
async function importLocations() {
    console.log('\nImporting locations...');
    const exportsDir = path.join(__dirname, 'exports');

    for (const location of ['isgav', 'frankfurt']) {
        const filePath = path.join(exportsDir, `location-${location}.json`);
        if (!fs.existsSync(filePath)) {
            console.log(`  Skipping ${location} - file not found`);
            continue;
        }

        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        const item = {
            id: location,
            categories: data.categories || [],
            taskLists: data.taskLists || [],
            version: 1,
            updatedAt: new Date().toISOString()
        };

        await putItem(TABLES.locations.TableName, item);
        console.log(`  -> Imported ${location}: ${item.categories.length} categories, ${item.taskLists.length} task lists`);
    }
}

async function importSchedules() {
    console.log('\nImporting schedules...');
    const filePath = path.join(__dirname, 'exports', 'employee-schedules.json');

    if (!fs.existsSync(filePath)) {
        console.log('  No employee-schedules.json found, skipping');
        return;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let count = 0;

    for (const [docId, docData] of Object.entries(data)) {
        let item;

        if (docId === 'config') {
            // Config document contains employees and shift hours
            item = {
                id: 'config',
                employees: docData.employees || [],
                shiftHours: docData.shiftHours || {},
                updatedAt: new Date().toISOString()
            };
        } else {
            // Weekly schedule documents
            item = {
                id: `week-${docId}`,
                weekStart: docData.weekStart || docId,
                availability: docData.availability || {},
                finalSchedule: docData.finalSchedule || null,
                updatedAt: new Date().toISOString()
            };
        }

        await putItem(TABLES.schedules.TableName, item);
        count++;
    }

    console.log(`  -> Imported ${count} schedule documents`);
}

async function importReminders() {
    console.log('\nImporting reminders...');
    const filePath = path.join(__dirname, 'exports', 'reminders.json');

    if (!fs.existsSync(filePath)) {
        console.log('  No reminders.json found, skipping');
        return;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let count = 0;

    for (const [docId, docData] of Object.entries(data)) {
        const item = {
            id: docId,
            title: docData.title,
            time: docData.time,
            type: docData.type || 'recurring',
            enabled: docData.enabled !== false,
            days: docData.days || [],
            date: docData.date || null,
            createdAt: docData.createdAt
                ? (docData.createdAt._seconds
                    ? new Date(docData.createdAt._seconds * 1000).toISOString()
                    : docData.createdAt)
                : new Date().toISOString()
        };

        await putItem(TABLES.reminders.TableName, item);
        count++;
    }

    console.log(`  -> Imported ${count} reminders`);
}

async function importBackups() {
    console.log('\nImporting backups...');
    const filePath = path.join(__dirname, 'exports', 'backups.json');

    if (!fs.existsSync(filePath)) {
        console.log('  No backups.json found, skipping');
        return;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let count = 0;
    let failed = 0;

    console.log(`  Found ${Object.keys(data).length} backups to import...`);

    for (const [docId, docData] of Object.entries(data)) {
        try {
            const item = {
                id: docId,
                location: docData.location || 'unknown',
                categories: docData.categories || [],
                taskLists: docData.taskLists || [],
                backupTime: docData.backupTime || new Date().toISOString()
            };

            await putItem(TABLES.backups.TableName, item);
            count++;

            if (count % 50 === 0) {
                console.log(`     Progress: ${count}/${Object.keys(data).length}`);
            }
        } catch (err) {
            failed++;
            console.log(`     Warning: Failed to import backup ${docId}: ${err.message}`);
        }
    }

    console.log(`  -> Imported ${count} backups (${failed} failed)`);
}

// Main function
async function main() {
    console.log('='.repeat(50));
    console.log('DynamoDB Import Script');
    console.log('='.repeat(50));
    console.log(`\nTable prefix: ${TABLE_PREFIX}`);
    console.log(`Region: ${process.env.AWS_REGION || 'eu-central-1'}`);

    try {
        // Create tables
        console.log('\nCreating tables...');
        for (const tableConfig of Object.values(TABLES)) {
            await createTableIfNotExists(tableConfig);
        }

        // Import data
        await importLocations();
        await importSchedules();
        await importReminders();
        await importBackups();

        console.log('\n' + '='.repeat(50));
        console.log('Import complete!');
        console.log('='.repeat(50));

    } catch (error) {
        console.error('\nImport failed:', error);
        process.exit(1);
    }
}

main();
