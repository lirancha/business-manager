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

        // Initial load
        this.getLocation(locationId).then(data => {
            this.versionCache.set(pollerId, data);
            callback(data);
        }).catch(err => {
            console.error('[API] Initial load failed:', err);
            callback({ categories: [], taskLists: [], version: 0 });
        });

        // Set up polling
        const poll = async () => {
            try {
                const data = await this.getLocation(locationId);
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
            clearInterval(intervalId);
            this.activePollers.delete(pollerId);
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
