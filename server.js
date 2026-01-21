const { Client, LocalAuth } = require('whatsapp-web.js');

console.log('--- WA SERVER VERSION 2.1 (WITH LOGGING) STARTED ---');

const originalInject = Client.prototype.inject;
Client.prototype.inject = async function(...args) {
    try {
        return await originalInject.apply(this, args);
    } catch (e) {
        if (e && e.message && typeof e.message === 'string' && e.message.includes('Execution context was destroyed')) {
            console.log('Ignored ExecutionContext navigation error during inject, will retry on next navigation.');
            return;
        }
        throw e;
    }
};
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// [FIX CPANEL ROUTING]
// Handle subfolder path /wa-api by stripping it
app.use((req, res, next) => {
    if (req.url.startsWith('/wa-api')) {
        req.url = req.url.replace('/wa-api', '') || '/';
    }
    next();
});

// Root endpoint for health check
app.get('/', (req, res) => {
    res.send('WhatsApp API Server is running');
});

// [OPTIMASI HOSTING]
// Gunakan PORT dari environment variable (penting untuk cPanel/Passenger/Heroku/Railway)
const PORT = process.env.PORT || 3000;

// [OPTIMASI HOSTING]
// URL Webhook PHP default, bisa di-override via env var atau config
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://sasinodev.cloud/demo/mod/api/whatsapp_ai_webhook.php';

// In-memory store for status
let clientStatus = 'disconnected';
let clientInfo = null;
let lastQr = null;
let contactsCache = [];
let botConfig = {
    rejectCall: false,
    markRead: false
};

// Create HTTP server from express app
const server = http.createServer(app);

// Socket.io setup with express server instance
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    }
});

// Gracefully reinitialize with userDataDir check
async function reinitializeClient() {
    try {
        // Attempt logout to free userDataDir
        await client.logout().catch(() => {});
        // Small delay before re-init
        setTimeout(() => {
            try {
                client.initialize();
            } catch (e) {
                console.error('Error during client reinitialize', e.message || e);
            }
        }, 1000);
    } catch (e) {
        console.error('Error during logout before reinitialize', e.message || e);
    }
}

client.on('qr', (qr) => {
    console.log('QR Code received');
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR code', err);
            return;
        }
        lastQr = url;
        clientStatus = 'qr_ready';
        io.emit('qr', url);
        io.emit('status', { status: clientStatus });
    });
});

client.on('ready', async () => {
    console.log('WhatsApp Client is ready!');
    clientStatus = 'connected';
    
    let profilePicUrl = '';
    try {
        profilePicUrl = await client.getProfilePicUrl(client.info.wid._serialized);
    } catch (e) {
        console.error('Error getting profile pic', e);
    }

    clientInfo = {
        ...client.info,
        profilePicUrl: profilePicUrl
    };

    lastQr = null;
    // Patch sendSeen to avoid crashes on undefined chats
    if (client.pupPage) {
        client.pupPage.evaluate(() => {
            if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                const originalSendSeen = window.WWebJS.sendSeen;
                window.WWebJS.sendSeen = async (...args) => {
                    try {
                        return await originalSendSeen(...args);
                    } catch (e) {
                        console.log('Ignored sendSeen error', e && e.message ? e.message : e);
                        return null;
                    }
                };
            }
        }).catch(() => {});
    }
    io.emit('status', { 
        status: clientStatus, 
        info: {
            wid: client.info.wid,
            pushname: client.info.pushname,
            platform: client.info.platform,
            profilePicUrl: profilePicUrl
        }
    });
    refreshContacts();
});

client.on('authenticated', () => {
    console.log('Authenticated');
    clientStatus = 'authenticated';
    io.emit('status', { status: clientStatus });
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    clientStatus = 'auth_failure';
    io.emit('status', { status: clientStatus, message: msg });
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    clientStatus = 'disconnected';
    clientInfo = null;
    lastQr = null;
    contactsCache = [];
    io.emit('status', { status: clientStatus });
    // Try graceful reinitialize instead of immediate initialize (to avoid userDataDir clash)
    reinitializeClient();
});

client.on('message', async msg => {
    console.log('MESSAGE RECEIVED', msg.body);
    
    if (msg.isStatus) return;

    let phoneDigits = msg.from.replace('@c.us', '');
    try {
        const contact = await msg.getContact();
        if (contact && contact.number) {
            phoneDigits = String(contact.number).replace(/\D+/g, '');
        }
    } catch (e) {
        console.error('Error getting contact info for incoming message', e.message || e);
    }

    try {
        await axios.post(WEBHOOK_URL, {
            phone: phoneDigits,
            from: phoneDigits,
            from_jid: msg.from,
            body: msg.body,
            name: msg._data.notifyName || '',
            timestamp: msg.timestamp
        });
        console.log('Message forwarded to webhook');
    } catch (error) {
        if (error.response) {
            console.error('Error forwarding message to webhook:', error.response.status, JSON.stringify(error.response.data));
        } else {
            console.error('Error forwarding message to webhook:', error.message);
        }
    }
    
    // Auto Mark Read if enabled
    if (botConfig.markRead) {
        try {
            const chat = await msg.getChat();
            await chat.sendSeen();
        } catch (e) {
            console.error('Error marking read:', e.message);
        }
    }

    if (clientStatus === 'connected') {
        refreshContacts();
    }
});

client.on('call', async call => {
    if (botConfig.rejectCall) {
        try {
            await call.reject();
            console.log('Incoming call rejected automatically.');
        } catch (e) {
            console.error('Error rejecting call:', e.message);
        }
    }
});

async function refreshContacts() {
    if (clientStatus !== 'connected') {
        contactsCache = [];
        return;
    }
    try {
        const chats = await client.getChats();
        contactsCache = chats
            .filter(chat => !chat.isGroup)
            .map(chat => {
                const contactName = chat.name || (chat.contact && chat.contact.pushname) || chat.id.user;
                const last = chat.lastMessage || null;
                return {
                    id: chat.id._serialized,
                    name: contactName,
                    phone: chat.id.user,
                    isGroup: chat.isGroup,
                    unreadCount: chat.unreadCount || 0,
                    lastMessage: last ? last.body : '',
                    lastMessageAt: last ? last.timestamp : null
                };
            })
            .sort((a, b) => {
                const ta = a.lastMessageAt || 0;
                const tb = b.lastMessageAt || 0;
                return tb - ta;
            });
        io.emit('contacts', contactsCache);
    } catch (e) {
        console.error('Error loading contacts', e);
    }
}

// API Endpoint to send message
app.post('/send-message', async (req, res) => {
    const { phone, message, chat_id } = req.body;

    if ((!phone && !chat_id) || !message) {
        return res.status(400).json({ error: 'Phone or chat_id and message are required' });
    }

    if (clientStatus !== 'connected' && clientStatus !== 'authenticated') {
        return res.status(503).json({ error: 'WhatsApp client is not connected' });
    }

    try {
        let chatId = chat_id || phone;
        if (!chatId.includes('@')) {
            const numberId = await client.getNumberId(chatId);
            if (!numberId) {
                return res.status(400).json({ error: 'The number is not a valid WhatsApp user' });
            }
            chatId = numberId._serialized;
        }
        const response = await client.sendMessage(chatId, message);
        res.json({ success: true, response });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({
        status: clientStatus,
        info: clientInfo,
        qr: lastQr
    });
});

app.post('/reset-session', async (req, res) => {
    try {
        clientStatus = 'disconnected';
        clientInfo = null;
        lastQr = null;
        contactsCache = [];
        await client.logout();
        client.initialize();
        res.json({ success: true });
    } catch (error) {
        console.error('Error resetting session', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint to update bot configuration
app.post('/config', (req, res) => {
    const { rejectCall, markRead } = req.body;
    if (typeof rejectCall !== 'undefined') botConfig.rejectCall = !!rejectCall;
    if (typeof markRead !== 'undefined') botConfig.markRead = !!markRead;
    res.json({ success: true, config: botConfig });
});

// Endpoint to set chat state (typing/recording)
app.post('/chat-state', async (req, res) => {
    const { phone, state } = req.body; // state: 'typing', 'recording', 'clear'
    if (!phone || !state) return res.status(400).json({ error: 'Phone and state are required' });
    
    if (clientStatus !== 'connected') return res.status(503).json({ error: 'WhatsApp not connected' });

    try {
        let chatId = phone;
        if (!chatId.includes('@')) {
            const numberId = await client.getNumberId(chatId);
            if (!numberId) return res.status(400).json({ error: 'Invalid number' });
            chatId = numberId._serialized;
        }
        
        const chat = await client.getChatById(chatId);
        if (state === 'typing') {
            await chat.sendStateTyping();
        } else if (state === 'recording') {
            await chat.sendStateRecording();
        } else if (state === 'clear') {
            await chat.clearState();
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Socket connection
io.on('connection', (socket) => {
    console.log('New client connected');
    socket.emit('status', { 
        status: clientStatus,
        info: clientInfo
    });
    if (clientStatus === 'qr_ready' && lastQr) {
        socket.emit('qr', lastQr);
    }
    if (contactsCache && contactsCache.length > 0) {
        socket.emit('contacts', contactsCache);
    }
    socket.on('get_contacts', () => {
        if (contactsCache && contactsCache.length > 0) {
            socket.emit('contacts', contactsCache);
        } else if (clientStatus === 'connected') {
            refreshContacts();
        }
    });
});

// [ANTI-CRASH] Handle initialization errors
const startClient = async () => {
    try {
        console.log('Initializing WhatsApp Client...');
        await client.initialize();
    } catch (error) {
        console.error('Failed to initialize WhatsApp Client:', error.message);
        clientStatus = 'auth_failure'; // or a new status like 'browser_error'
        io.emit('status', { 
            status: clientStatus, 
            message: 'Browser Launch Failed: ' + error.message 
        });
    }
};

startClient();

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Prevent process exit on unhandled errors
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    // Keep server running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
    // Keep server running
});
