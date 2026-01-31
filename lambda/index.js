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
    backups: `${TABLE_PREFIX}-backups`,
    suppliers: `${TABLE_PREFIX}-suppliers`,
    orders: `${TABLE_PREFIX}-orders`
};

// CORS headers - supports multiple origins for local testing
const ALLOWED_ORIGINS = [
    'https://lirancha.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'null'  // For file:// access during local development
];

function getCorsHeaders(event) {
    const origin = event?.headers?.origin || event?.headers?.Origin || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Content-Type': 'application/json'
    };
}

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));
    currentEvent = event; // Store for CORS handling

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: getCorsHeaders(event),
            body: JSON.stringify({ message: 'OK' })
        };
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

        // =====================================================
        // SUPPLIERS & ORDERS
        // =====================================================

        // /suppliers
        if (path === '/suppliers') {
            if (method === 'GET') return await listSuppliers(event.queryStringParameters);
            if (method === 'POST') return await createSupplier(body);
        }

        // /suppliers/{id}
        if (path.match(/^\/suppliers\/[^/]+$/)) {
            const id = pathParams.id || path.split('/').pop();
            if (method === 'PUT') return await updateSupplier(id, body);
            if (method === 'DELETE') return await deleteSupplier(id);
        }

        // /orders
        if (path === '/orders') {
            if (method === 'GET') return await listOrders(event.queryStringParameters);
            if (method === 'POST') return await createOrder(body);
            if (method === 'DELETE') return await deleteAllOrders();
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

    // SAFETY: Block if both arrays are empty - prevents accidental data wipe
    const categoryCount = data.categories?.length || 0;
    const taskListCount = data.taskLists?.length || 0;
    if (categoryCount === 0 && taskListCount === 0) {
        console.warn('[Lambda] Blocked saving empty state for location:', locationId);
        return response(400, { error: 'Cannot save empty state - both categories and taskLists are empty' });
    }

    // SAFETY: Detect suspicious data reduction
    const currentResult = await docClient.send(new GetCommand({
        TableName: TABLES.locations,
        Key: { id: locationId }
    }));
    const current = currentResult.Item;

    if (current) {
        const prevProductCount = current.categories?.reduce((sum, c) => sum + (c.products?.length || 0), 0) || 0;
        const newProductCount = data.categories?.reduce((sum, c) => sum + (c.products?.length || 0), 0) || 0;
        const prevTaskCount = current.taskLists?.reduce((sum, t) => sum + (t.tasks?.length || 0), 0) || 0;
        const newTaskCount = data.taskLists?.reduce((sum, t) => sum + (t.tasks?.length || 0), 0) || 0;

        // Block if we had significant data and now have almost nothing
        if ((prevProductCount > 10 && newProductCount < 3) ||
            (prevTaskCount > 10 && newTaskCount < 3)) {
            console.error('[Lambda] BLOCKED suspicious data loss!', {
                location: locationId,
                previousProducts: prevProductCount,
                newProducts: newProductCount,
                previousTasks: prevTaskCount,
                newTasks: newTaskCount
            });
            return response(400, {
                error: 'Suspicious data reduction detected',
                details: `Previous: ${prevProductCount} products, ${prevTaskCount} tasks. New: ${newProductCount} products, ${newTaskCount} tasks.`
            });
        }
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
// SUPPLIERS
// =====================================================

async function listSuppliers(queryParams) {
    const result = await docClient.send(new ScanCommand({
        TableName: TABLES.suppliers
    }));

    let items = result.Items || [];

    // Filter by location
    if (queryParams?.location) {
        items = items.filter(s => s.location === queryParams.location);
    }

    // Sort by name
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return response(200, items);
}

async function createSupplier(data) {
    if (!data || !data.name) {
        return response(400, { error: 'Missing required field: name' });
    }

    const id = `sup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const item = {
        id,
        name: data.name,
        phone: data.phone || null,
        notes: data.notes || null,
        location: data.location || 'isgav',
        createdAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.suppliers,
        Item: item
    }));

    return response(201, item);
}

async function updateSupplier(id, data) {
    // Get existing supplier
    const existing = await docClient.send(new GetCommand({
        TableName: TABLES.suppliers,
        Key: { id }
    }));

    if (!existing.Item) {
        return response(404, { error: 'Supplier not found' });
    }

    const item = {
        ...existing.Item,
        name: data.name || existing.Item.name,
        phone: data.phone !== undefined ? data.phone : existing.Item.phone,
        notes: data.notes !== undefined ? data.notes : existing.Item.notes,
        location: data.location || existing.Item.location,
        updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.suppliers,
        Item: item
    }));

    return response(200, item);
}

async function deleteSupplier(id) {
    await docClient.send(new DeleteCommand({
        TableName: TABLES.suppliers,
        Key: { id }
    }));

    return response(200, { message: 'Deleted' });
}

// =====================================================
// ORDERS
// =====================================================

async function listOrders(queryParams) {
    const result = await docClient.send(new ScanCommand({
        TableName: TABLES.orders
    }));

    let items = result.Items || [];

    // Filter by location
    if (queryParams?.location) {
        items = items.filter(order => order.location === queryParams.location);
    }

    // Filter by month (format: YYYY-MM)
    if (queryParams?.month) {
        items = items.filter(order => order.date && order.date.startsWith(queryParams.month));
    }

    // Filter by supplier
    if (queryParams?.supplier) {
        items = items.filter(order => order.supplierId === queryParams.supplier);
    }

    // Sort by date descending
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return response(200, items);
}

async function createOrder(data) {
    if (!data || !data.items || data.items.length === 0) {
        return response(400, { error: 'Missing required field: items' });
    }

    const id = `ord-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const item = {
        id,
        supplierId: data.supplierId || null,
        supplierName: data.supplierName || null,
        categoryId: data.categoryId || null,
        categoryName: data.categoryName || null,
        date: data.date || now.toISOString().split('T')[0], // YYYY-MM-DD
        items: data.items, // [{name, quantity, unit}]
        orderText: data.orderText || null,
        location: data.location || 'isgav',
        sharedVia: data.sharedVia || 'manual',
        createdAt: now.toISOString()
    };

    await docClient.send(new PutCommand({
        TableName: TABLES.orders,
        Item: item
    }));

    return response(201, item);
}

async function deleteAllOrders() {
    // Get all orders
    const result = await docClient.send(new ScanCommand({
        TableName: TABLES.orders
    }));

    const items = result.Items || [];

    // Delete each order
    for (const item of items) {
        await docClient.send(new DeleteCommand({
            TableName: TABLES.orders,
            Key: { id: item.id }
        }));
    }

    return response(200, { deleted: items.length });
}

// =====================================================
// HELPERS
// =====================================================

// Store current event for CORS handling
let currentEvent = null;

function response(statusCode, body) {
    return {
        statusCode,
        headers: getCorsHeaders(currentEvent),
        body: JSON.stringify(body)
    };
}
