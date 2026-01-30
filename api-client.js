/**
 * API Client for Business Manager
 *
 * Replaces Firebase Firestore SDK with REST API calls to AWS API Gateway + Lambda.
 * Includes polling-based real-time sync to replace Firebase onSnapshot().
 *
 * Usage:
 *   <script src="api-client.js"></script>
 *   <script>
 *     // Initialize
 *     const api = new BusinessManagerAPI({
 *       baseUrl: 'https://xxx.execute-api.eu-central-1.amazonaws.com/prod',
 *       apiKey: 'your-api-key' // optional
 *     });
 *
 *     // Load location with real-time polling
 *     api.subscribeLocation('isgav', (data) => {
 *       state.categories = data.categories;
 *       state.taskLists = data.taskLists;
 *       renderAll();
 *     });
 *
 *     // Save data
 *     await api.saveLocation('isgav', { categories, taskLists });
 *   </script>
 */

class BusinessManagerAPI {
    constructor(config = {}) {
        // API Gateway URL - UPDATE THIS after deploying Lambda
        this.baseUrl = config.baseUrl || 'https://98mctlbso0.execute-api.eu-central-1.amazonaws.com/prod';
        this.apiKey = config.apiKey || null;

        // Polling configuration
        this.pollingInterval = config.pollingInterval || 5000; // 5 seconds
        this.activePollers = new Map(); // Track active pollers

        // Cache for version tracking (to detect changes)
        this.versionCache = new Map();

        // Pause polling when tab is hidden
        this._setupVisibilityHandling();
    }

    // =====================================================
    // HTTP Methods
    // =====================================================

    async _fetch(path, options = {}) {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
            ...options.headers
        };

        try {
            const response = await fetch(url, {
                ...options,
                headers
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: response.statusText }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`[API] Error fetching ${path}:`, error);
            throw error;
        }
    }

    async _get(path) {
        return this._fetch(path, { method: 'GET' });
    }

    async _post(path, data) {
        return this._fetch(path, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async _put(path, data) {
        return this._fetch(path, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async _delete(path) {
        return this._fetch(path, { method: 'DELETE' });
    }

    // =====================================================
    // LOCATIONS (Inventory & Tasks)
    // =====================================================

    /**
     * Get location data (inventory categories and task lists)
     */
    async getLocation(locationId) {
        return this._get(`/locations/${locationId}`);
    }

    /**
     * Save location data with backup
     */
    async saveLocation(locationId, data) {
        // SAFETY: Never save if both arrays are empty - prevents accidental data wipe
        if ((!data.categories || data.categories.length === 0) &&
            (!data.taskLists || data.taskLists.length === 0)) {
            console.warn('[API] Blocked saving empty state - this prevents accidental data loss');
            return null;
        }

        // SAFETY: Detect suspicious data reduction (potential race condition or corruption)
        const cached = this.versionCache.get(`location-${locationId}`);
        if (cached) {
            const prevProductCount = cached.categories?.reduce((sum, c) => sum + (c.products?.length || 0), 0) || 0;
            const newProductCount = data.categories?.reduce((sum, c) => sum + (c.products?.length || 0), 0) || 0;
            const prevTaskCount = cached.taskLists?.reduce((sum, t) => sum + (t.tasks?.length || 0), 0) || 0;
            const newTaskCount = data.taskLists?.reduce((sum, t) => sum + (t.tasks?.length || 0), 0) || 0;

            // Block if we had significant data and now have almost nothing
            // (more than 10 products/tasks before, less than 3 now = suspicious)
            if ((prevProductCount > 10 && newProductCount < 3) ||
                (prevTaskCount > 10 && newTaskCount < 3)) {
                console.error('[API] BLOCKED suspicious data loss!', {
                    location: locationId,
                    previousProducts: prevProductCount,
                    newProducts: newProductCount,
                    previousTasks: prevTaskCount,
                    newTasks: newTaskCount
                });
                console.warn('[API] If this is intentional, clear the browser cache and reload');
                return null;
            }
        }

        // Create backup before saving
        const currentData = this.versionCache.get(`location-${locationId}`);
        if (currentData && (currentData.categories?.length > 0 || currentData.taskLists?.length > 0)) {
            await this.createBackup({
                ...currentData,
                location: locationId
            }).catch(err => console.warn('[API] Backup failed:', err));
        }

        // Save new data
        const result = await this._put(`/locations/${locationId}`, {
            categories: data.categories,
            taskLists: data.taskLists,
            version: data.version || this.versionCache.get(`location-${locationId}`)?.version || 0
        });

        // Update version cache
        this.versionCache.set(`location-${locationId}`, result);

        return result;
    }

    /**
     * Subscribe to location changes (polling-based)
     * Returns an unsubscribe function
     */
    subscribeLocation(locationId, callback) {
        const pollerId = `location-${locationId}`;
        let isSubscribed = true; // Track subscription state to prevent race conditions

        // Initial load
        this.getLocation(locationId).then(data => {
            // Guard: Don't fire callback if unsubscribed (location was switched)
            if (!isSubscribed) {
                console.log('[API] Ignoring initial load callback - subscription cancelled for', locationId);
                return;
            }
            this.versionCache.set(pollerId, data);
            callback(data);
        }).catch(err => {
            console.error('[API] Initial load failed:', err);
            if (isSubscribed) {
                callback({ categories: [], taskLists: [], version: 0 });
            }
        });

        // Set up polling
        const poll = async () => {
            // Guard: Don't poll if unsubscribed or polling is paused
            if (!isSubscribed || this._pollingPaused) {
                return;
            }
            try {
                const data = await this.getLocation(locationId);

                // Guard: Check again after async call - location may have switched
                if (!isSubscribed) {
                    console.log('[API] Ignoring poll callback - subscription cancelled for', locationId);
                    return;
                }

                const cached = this.versionCache.get(pollerId);

                // Only callback if version changed
                if (!cached || data.version !== cached.version) {
                    this.versionCache.set(pollerId, data);
                    callback(data);
                }
            } catch (err) {
                console.error('[API] Poll failed:', err);
            }
        };

        const intervalId = setInterval(poll, this.pollingInterval);
        this.activePollers.set(pollerId, intervalId);

        // Return unsubscribe function
        return () => {
            isSubscribed = false; // Mark as unsubscribed to cancel pending callbacks
            clearInterval(intervalId);
            this.activePollers.delete(pollerId);
            console.log('[API] Unsubscribed from location:', locationId);
        };
    }

    // =====================================================
    // SCHEDULES
    // =====================================================

    /**
     * Get schedule config (employees and shift hours)
     */
    async getScheduleConfig() {
        return this._get('/schedules/config');
    }

    /**
     * Save schedule config
     */
    async saveScheduleConfig(data) {
        return this._put('/schedules/config', data);
    }

    /**
     * Get schedule for a specific week
     */
    async getScheduleWeek(weekId) {
        return this._get(`/schedules/${weekId}`);
    }

    /**
     * Save schedule for a specific week
     */
    async saveScheduleWeek(weekId, data) {
        return this._put(`/schedules/${weekId}`, data);
    }

    // =====================================================
    // REMINDERS
    // =====================================================

    /**
     * List all reminders
     */
    async listReminders() {
        return this._get('/reminders');
    }

    /**
     * Create a new reminder
     */
    async createReminder(data) {
        return this._post('/reminders', data);
    }

    /**
     * Update a reminder
     */
    async updateReminder(id, data) {
        return this._put(`/reminders/${id}`, data);
    }

    /**
     * Delete a reminder
     */
    async deleteReminder(id) {
        return this._delete(`/reminders/${id}`);
    }

    /**
     * Subscribe to reminders (polling-based)
     */
    subscribeReminders(callback) {
        const pollerId = 'reminders';
        let lastCount = 0;

        // Initial load
        this.listReminders().then(data => {
            lastCount = data.length;
            callback(data);
        }).catch(err => {
            console.error('[API] Initial reminders load failed:', err);
            callback([]);
        });

        // Set up polling (less frequent for reminders)
        const poll = async () => {
            try {
                const data = await this.listReminders();
                // Simple change detection based on count
                // (For more accurate detection, could compare IDs or timestamps)
                if (data.length !== lastCount) {
                    lastCount = data.length;
                    callback(data);
                }
            } catch (err) {
                console.error('[API] Reminders poll failed:', err);
            }
        };

        const intervalId = setInterval(poll, 30000); // Poll every 30 seconds for reminders
        this.activePollers.set(pollerId, intervalId);

        return () => {
            clearInterval(intervalId);
            this.activePollers.delete(pollerId);
        };
    }

    // =====================================================
    // BACKUPS
    // =====================================================

    /**
     * Create a backup
     */
    async createBackup(data) {
        return this._post('/backups', data);
    }

    /**
     * List recent backups
     */
    async listBackups() {
        return this._get('/backups');
    }

    // =====================================================
    // TELEGRAM SETTINGS
    // =====================================================

    /**
     * Get Telegram settings (checks if configured)
     */
    async getTelegramSettings() {
        return this._get('/settings/telegram');
    }

    /**
     * Save Telegram settings
     */
    async saveTelegramSettings(botToken, chatId) {
        return this._put('/settings/telegram', { botToken, chatId });
    }

    /**
     * Send a test Telegram message
     */
    async testTelegram() {
        return this._post('/telegram/test', {});
    }

    // =====================================================
    // SUPPLIERS
    // =====================================================

    /**
     * List all suppliers
     * @param {string} location - Optional location filter
     */
    async listSuppliers(location = null) {
        const params = new URLSearchParams();
        if (location) params.append('location', location);
        const query = params.toString();
        return this._get(`/suppliers${query ? '?' + query : ''}`);
    }

    /**
     * Create a supplier
     * @param {Object} data - { name, phone, notes, location }
     */
    async createSupplier(data) {
        return this._post('/suppliers', data);
    }

    /**
     * Update a supplier
     * @param {string} id - Supplier ID
     * @param {Object} data - { name, phone, notes, location }
     */
    async updateSupplier(id, data) {
        return this._put(`/suppliers/${id}`, data);
    }

    /**
     * Delete a supplier
     */
    async deleteSupplier(id) {
        return this._delete(`/suppliers/${id}`);
    }

    // =====================================================
    // ORDERS
    // =====================================================

    /**
     * Create an order record
     * @param {Object} data - { supplierId, supplierName, categoryId, categoryName, items, orderText, location, sharedVia }
     */
    async createOrder(data) {
        return this._post('/orders', data);
    }

    /**
     * List orders with optional filters
     * @param {Object} filters - { location, month: 'YYYY-MM', supplier: 'supplier-id' }
     */
    async listOrders(filters = {}) {
        const params = new URLSearchParams();
        if (filters.location) params.append('location', filters.location);
        if (filters.month) params.append('month', filters.month);
        if (filters.supplier) params.append('supplier', filters.supplier);
        const query = params.toString();
        return this._get(`/orders${query ? '?' + query : ''}`);
    }

    // =====================================================
    // POLLING MANAGEMENT
    // =====================================================

    /**
     * Pause all polling (e.g., when tab is hidden)
     */
    pausePolling() {
        this._pollingPaused = true;
        console.log('[API] Polling paused');
    }

    /**
     * Resume all polling
     */
    resumePolling() {
        this._pollingPaused = false;
        console.log('[API] Polling resumed');
    }

    /**
     * Stop all active polling
     */
    stopAllPolling() {
        for (const [id, intervalId] of this.activePollers) {
            clearInterval(intervalId);
        }
        this.activePollers.clear();
        console.log('[API] All polling stopped');
    }

    /**
     * Set up visibility change handling to pause/resume polling
     */
    _setupVisibilityHandling() {
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this.pausePolling();
                } else {
                    this.resumePolling();
                }
            });
        }
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BusinessManagerAPI;
}

// Also make available globally for script tag usage
if (typeof window !== 'undefined') {
    window.BusinessManagerAPI = BusinessManagerAPI;
}
