/**
 * AWS Lambda: Business Manager Reminder Checker
 *
 * Triggered every minute by EventBridge to check for due reminders
 * and send Telegram notifications.
 *
 * Environment Variables:
 * - AWS_REGION: AWS region (default: eu-central-1)
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Initialize clients
const region = process.env.AWS_REGION || 'eu-central-1';
const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({ region });

// Table names
const REMINDERS_TABLE = 'business-manager-reminders';
const SENT_REMINDERS_TABLE = 'business-manager-sent-reminders';
const TELEGRAM_SECRET_NAME = 'business-manager/telegram';

// Day names in Hebrew (matching frontend)
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * Main Lambda handler - triggered by EventBridge every minute
 */
exports.handler = async (event) => {
    console.log('Reminder checker started:', new Date().toISOString());

    try {
        // Get Telegram credentials
        const telegram = await getTelegramCredentials();
        if (!telegram) {
            console.log('Telegram not configured, skipping');
            return { statusCode: 200, body: 'Telegram not configured' };
        }

        // Get current time in Israel timezone
        const now = new Date();
        const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
        const currentHour = israelTime.getHours().toString().padStart(2, '0');
        const currentMinute = israelTime.getMinutes().toString().padStart(2, '0');
        const currentTime = `${currentHour}:${currentMinute}`;
        const currentDayIndex = israelTime.getDay(); // 0 = Sunday
        const currentDayName = DAY_NAMES[currentDayIndex];
        const currentDateStr = formatDate(israelTime); // DD/MM/YYYY

        console.log(`Current time: ${currentTime}, Day: ${currentDayName}, Date: ${currentDateStr}`);

        // Get all enabled reminders
        const reminders = await getEnabledReminders();
        console.log(`Found ${reminders.length} enabled reminders`);

        // Filter reminders that are due now
        const dueReminders = reminders.filter(reminder => {
            // Check if time matches
            if (reminder.time !== currentTime) {
                return false;
            }

            // Check based on reminder type
            if (reminder.type === 'recurring') {
                // Recurring: check if current day is in the days array
                return reminder.days && reminder.days.includes(currentDayName);
            } else if (reminder.type === 'one-time') {
                // One-time: check if current date matches
                return reminder.date === currentDateStr;
            }

            return false;
        });

        console.log(`${dueReminders.length} reminders are due now`);

        // Process each due reminder
        let sentCount = 0;
        for (const reminder of dueReminders) {
            const sentKey = `${reminder.id}-${currentDateStr.replace(/\//g, '-')}`;

            // Check if already sent today
            const alreadySent = await checkIfSent(sentKey);
            if (alreadySent) {
                console.log(`Reminder ${reminder.id} already sent today, skipping`);
                continue;
            }

            // Send Telegram notification
            const success = await sendTelegramNotification(telegram, reminder);

            if (success) {
                // Record as sent (with 7-day TTL)
                await markAsSent(sentKey, reminder.id);
                sentCount++;
                console.log(`Sent reminder: ${reminder.title}`);

                // For one-time reminders, disable them after sending
                if (reminder.type === 'one-time') {
                    await disableReminder(reminder.id);
                    console.log(`Disabled one-time reminder: ${reminder.id}`);
                }
            }
        }

        const result = {
            statusCode: 200,
            body: JSON.stringify({
                checked: reminders.length,
                due: dueReminders.length,
                sent: sentCount,
                time: currentTime,
                day: currentDayName
            })
        };

        console.log('Reminder checker completed:', result.body);
        return result;

    } catch (error) {
        console.error('Error in reminder checker:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

/**
 * Get Telegram credentials from Secrets Manager
 */
async function getTelegramCredentials() {
    try {
        const result = await secretsClient.send(new GetSecretValueCommand({
            SecretId: TELEGRAM_SECRET_NAME
        }));
        const secret = JSON.parse(result.SecretString);
        if (!secret.botToken || !secret.chatId) {
            return null;
        }
        return secret;
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            return null;
        }
        throw error;
    }
}

/**
 * Get all enabled reminders from DynamoDB
 */
async function getEnabledReminders() {
    const result = await docClient.send(new ScanCommand({
        TableName: REMINDERS_TABLE,
        FilterExpression: 'enabled = :enabled',
        ExpressionAttributeValues: {
            ':enabled': true
        }
    }));
    return result.Items || [];
}

/**
 * Check if reminder was already sent today
 */
async function checkIfSent(sentKey) {
    try {
        const result = await docClient.send(new GetCommand({
            TableName: SENT_REMINDERS_TABLE,
            Key: { id: sentKey }
        }));
        return !!result.Item;
    } catch (error) {
        // Table might not exist yet, that's okay
        console.log('Error checking sent status:', error.message);
        return false;
    }
}

/**
 * Mark reminder as sent with 7-day TTL
 */
async function markAsSent(sentKey, reminderId) {
    const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // 7 days from now

    await docClient.send(new PutCommand({
        TableName: SENT_REMINDERS_TABLE,
        Item: {
            id: sentKey,
            reminderId: reminderId,
            sentAt: new Date().toISOString(),
            expiresAt: ttl
        }
    }));
}

/**
 * Disable a one-time reminder after it's sent
 */
async function disableReminder(reminderId) {
    const result = await docClient.send(new GetCommand({
        TableName: REMINDERS_TABLE,
        Key: { id: reminderId }
    }));

    if (result.Item) {
        await docClient.send(new PutCommand({
            TableName: REMINDERS_TABLE,
            Item: {
                ...result.Item,
                enabled: false,
                updatedAt: new Date().toISOString()
            }
        }));
    }
}

/**
 * Send Telegram notification
 */
async function sendTelegramNotification(telegram, reminder) {
    const message = `🔔 <b>תזכורת</b>\n\n${reminder.title}`;

    const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: telegram.chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });

        const result = await response.json();

        if (!result.ok) {
            console.error('Telegram API error:', result.description);
            return false;
        }

        return true;
    } catch (error) {
        console.error('Failed to send Telegram message:', error);
        return false;
    }
}

/**
 * Format date as DD/MM/YYYY (to match frontend format)
 */
function formatDate(date) {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}
