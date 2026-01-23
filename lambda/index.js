/**
 * AWS Lambda handler for Business Manager API
 *
 * This Lambda function serves as the backend for the Business Manager app,
 * replacing Firebase Firestore with AWS DynamoDB.
 *
 * Environment Variables Required:
 * - DYNAMODB_TABLE_PREFIX: Prefix for DynamoDB table names (default: 'business-manager')
 * - ALLOWED_ORIGIN: CORS origin (default: 'https://lirancha.github.io')
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    ScanCommand
} = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand } = require('@aws-sdk/client-secrets-manager');

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const docClient = DynamoDBDocumentClient.from(client);

// Initialize Secrets Manager client
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const TELEGRAM_SECRET_NAME = 'business-manager/telegram';

// Table names
const TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX || 'business-manager';
const TABLES = {
    locations: `${TABLE_PREFIX}-locations`,
    schedules: `${TABLE_PREFIX}-schedules`,
    reminders: `${TABLE_PREFIX}-reminders`,
    backups: `${TABLE_PREFIX}-backups`
};

// CORS headers
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://lirancha.github.io';
const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Content-Type': 'application/json'
};

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return response(200, { message: 'OK' });
    }

    const path = event.path;
    const method = event.httpMethod;
    const pathParams = event.pathParameters || {};

    let body = null;
    if (event.body) {
        try {
            body = JSON.parse(event.body);
        } catch (e) {
            return response(400, { error: 'Invalid JSON body' });
        }
    }

    try {
        // Route requests
        // /locations/{locationId}
        if (path.match(/^\/locations\/[^/]+$/)) {
            const locationId = pathParams.locationId || path.split('/').pop();
            if (method === 'GET') return await getLocation(locationId);
            if (method === 'PUT') return await saveLocation(locationId, body);
        }

        // /schedules/config
        if (path === '/schedules/config') {
            if (method === 'GET') return await getScheduleConfig();
            if (method === 'PUT') return await saveScheduleConfig(body);
        }

        // /schedules/{weekId}
        if (path.match(/^\/schedules\/[^/]+$/) && path !== '/schedules/config') {
            const weekId = pathParams.weekId || path.split('/').pop();
            if (method === 'GET') return await getScheduleWeek(weekId);
            if (method === 'PUT') return await saveScheduleWeek(weekId, body);
        }

        // /reminders
        if (path === '/reminders') {
            if (method === 'GET') return await listReminders();
            if (method === 'POST') return await createReminder(body);
        }

        // /reminders/{id}
        if (path.match(/^\/reminders\/[^/]+$/)) {
            const id = pathParams.id || path.split('/').pop();
            if (method === 'GET') return await getReminder(id);
            if (method === 'PUT') return await updateReminder(id, body);
            if (method === 'DELETE') return await deleteReminder(id);
        }

        // /backups
        if (path === '/backups') {
            if (method === 'POST') return await createBackup(body);
            if (method === 'GET') return await listBackups();
        }

        // /settings/telegram
        if (path === '/settings/telegram') {
            if (method === 'GET') return await getTelegramSettings();
            if (method === 'PUT') return await saveTelegramSettings(body);
        }

        // /telegram/test
        if (path === '/telegram/test') {
            if (method === 'POST') return await testTelegram();
        }

        return response(404, { error: 'Not found' });
    } catch (error) {
        console.error('Error:', error);
        return response(500, { error: error.message });
    }
};

// =====================================================
// LOCATIONS (Inventory & Tasks)
// =====================================================

async function getLocation(locationId) {
    const result = await docClient.send(new GetCommand({
        TableName: TABLES.locations,
        Key: { id: locationId }
    }));

    if (!result.Item) {
        return response(200, {
            id: locationId,
            categories: [],
            taskLists: [],
            version: 0
        });
    }

    return response(200, result.Item);
}

async function saveLocation(locationId, data) {
    if (!data) {
        return response(400, { error: 'Missing data' });
    }

    // Increment version for change detection
    const currentVersion = data.version || 0;

    const item = {
        id: locationId,
        categories: data.categories || [],
        taskLists: data.taskLists || [],
        version: currentVersion + 1,
        updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.locations,
        Item: item
    }));

    return response(200, item);
}

// =====================================================
// SCHEDULES (Employees, Availability, Final Schedule)
// =====================================================

async function getScheduleConfig() {
    const result = await docClient.send(new GetCommand({
        TableName: TABLES.schedules,
        Key: { id: 'config' }
    }));

    if (!result.Item) {
        return response(200, {
            id: 'config',
            employees: [],
            shiftHours: {
                morning: { start: '06:30', end: '12:30' },
                afternoon: { start: '12:30', end: '16:30' },
                evening: { start: '16:30', end: '20:30' }
            }
        });
    }

    return response(200, result.Item);
}

async function saveScheduleConfig(data) {
    if (!data) {
        return response(400, { error: 'Missing data' });
    }

    const item = {
        id: 'config',
        employees: data.employees || [],
        shiftHours: data.shiftHours || {},
        updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.schedules,
        Item: item
    }));

    return response(200, item);
}

async function getScheduleWeek(weekId) {
    const result = await docClient.send(new GetCommand({
        TableName: TABLES.schedules,
        Key: { id: `week-${weekId}` }
    }));

    if (!result.Item) {
        return response(200, {
            id: `week-${weekId}`,
            weekStart: weekId,
            availability: {},
            finalSchedule: null
        });
    }

    return response(200, result.Item);
}

async function saveScheduleWeek(weekId, data) {
    if (!data) {
        return response(400, { error: 'Missing data' });
    }

    const item = {
        id: `week-${weekId}`,
        weekStart: weekId,
        availability: data.availability || {},
        finalSchedule: data.finalSchedule || null,
        updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.schedules,
        Item: item
    }));

    return response(200, item);
}

// =====================================================
// REMINDERS
// =====================================================

async function listReminders() {
    const result = await docClient.send(new ScanCommand({
        TableName: TABLES.reminders
    }));

    // Sort by createdAt descending
    const items = (result.Items || []).sort((a, b) => {
        return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return response(200, items);
}

async function getReminder(id) {
    const result = await docClient.send(new GetCommand({
        TableName: TABLES.reminders,
        Key: { id }
    }));

    if (!result.Item) {
        return response(404, { error: 'Reminder not found' });
    }

    return response(200, result.Item);
}

async function createReminder(data) {
    if (!data || !data.title || !data.time) {
        return response(400, { error: 'Missing required fields: title, time' });
    }

    const id = `rem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const item = {
        id,
        title: data.title,
        time: data.time,
        type: data.type || 'recurring',
        enabled: data.enabled !== false,
        days: data.days || [],
        date: data.date || null,
        createdAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.reminders,
        Item: item
    }));

    return response(201, item);
}

async function updateReminder(id, data) {
    // Get existing reminder
    const existing = await docClient.send(new GetCommand({
        TableName: TABLES.reminders,
        Key: { id }
    }));

    if (!existing.Item) {
        return response(404, { error: 'Reminder not found' });
    }

    const item = {
        ...existing.Item,
        ...data,
        id, // Ensure ID is not overwritten
        updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.reminders,
        Item: item
    }));

    return response(200, item);
}

async function deleteReminder(id) {
    await docClient.send(new DeleteCommand({
        TableName: TABLES.reminders,
        Key: { id }
    }));

    return response(200, { message: 'Deleted' });
}

// =====================================================
// BACKUPS
// =====================================================

async function createBackup(data) {
    if (!data) {
        return response(400, { error: 'Missing data' });
    }

    const id = `backup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const item = {
        id,
        ...data,
        backupTime: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.backups,
        Item: item
    }));

    return response(201, item);
}

async function listBackups() {
    const result = await docClient.send(new ScanCommand({
        TableName: TABLES.backups,
        Limit: 50 // Limit to recent backups
    }));

    // Sort by backupTime descending
    const items = (result.Items || []).sort((a, b) => {
        return new Date(b.backupTime) - new Date(a.backupTime);
    });

    return response(200, items);
}

// =====================================================
// TELEGRAM SETTINGS
// =====================================================

async function getTelegramSettings() {
    try {
        const result = await secretsClient.send(new GetSecretValueCommand({
            SecretId: TELEGRAM_SECRET_NAME
        }));

        const secret = JSON.parse(result.SecretString);
        // Don't expose full credentials, just confirm they exist
        return response(200, {
            configured: !!(secret.botToken && secret.chatId),
            chatId: secret.chatId ? `****${secret.chatId.slice(-4)}` : null
        });
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            return response(200, { configured: false, chatId: null });
        }
        throw error;
    }
}

async function saveTelegramSettings(data) {
    if (!data || !data.botToken || !data.chatId) {
        return response(400, { error: 'Missing required fields: botToken, chatId' });
    }

    const secretValue = JSON.stringify({
        botToken: data.botToken,
        chatId: data.chatId
    });

    try {
        // Try to update existing secret
        await secretsClient.send(new PutSecretValueCommand({
            SecretId: TELEGRAM_SECRET_NAME,
            SecretString: secretValue
        }));
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            // Secret doesn't exist, create it
            await secretsClient.send(new CreateSecretCommand({
                Name: TELEGRAM_SECRET_NAME,
                SecretString: secretValue,
                Description: 'Telegram bot credentials for Business Manager reminders'
            }));
        } else {
            throw error;
        }
    }

    return response(200, {
        success: true,
        message: 'Telegram settings saved',
        chatId: `****${data.chatId.slice(-4)}`
    });
}

async function testTelegram() {
    // Get credentials from Secrets Manager
    let botToken, chatId;
    try {
        const result = await secretsClient.send(new GetSecretValueCommand({
            SecretId: TELEGRAM_SECRET_NAME
        }));
        const secret = JSON.parse(result.SecretString);
        botToken = secret.botToken;
        chatId = secret.chatId;
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            return response(400, { error: 'Telegram not configured. Save settings first.' });
        }
        throw error;
    }

    if (!botToken || !chatId) {
        return response(400, { error: 'Telegram credentials incomplete' });
    }

    // Send test message
    const message = `✅ Business Manager Test\n\nTelegram notifications are working!\n\nTime: ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;

    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const telegramResponse = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        })
    });

    const telegramResult = await telegramResponse.json();

    if (!telegramResult.ok) {
        return response(400, {
            error: 'Telegram API error',
            details: telegramResult.description
        });
    }

    return response(200, {
        success: true,
        message: 'Test message sent successfully'
    });
}

// =====================================================
// HELPERS
// =====================================================

function response(statusCode, body) {
    return {
        statusCode,
        headers: corsHeaders,
        body: JSON.stringify(body)
    };
}
