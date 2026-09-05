/**
 * GLOBAL CONFIGURATION & ROUTING ENGINE
 * Spread Technical ITSM (Strict Android DB Schema Compliance)
 */
const DB_CONFIG = {
    ticketApiUrl: "https://script.google.com/macros/s/AKfycbzUtwju4tELvUTYBlVCWYTFp5LZ7cCkNbhWFzy081HHhABPPLzFUS4xjjBvhIO699wS/exec",
    userApiUrl: "https://script.google.com/macros/s/AKfycbz7tA_SYkLXzIxmeHEXFMQy70VB47cZrGjsh-qHjjjOvJVRHPBFCTAUI0QerWQKSXKZKQ/exec"
};

const STATUS_FLOW = ["Pending Approval", "Monitoring", "Assigned", "Working", "Resolved"];
const SESSION_TIMEOUT_MS = 12 * 60 * 60 * 1000;

let appConfigData = [];
let clientSession = null;
let nocDashboardTickets = [];
let filteredTicketsCache = [];
let IT_ROLE = "";
let IT_NAME = "";
let globalUsersList = [];
let globalRegisteredCompanies = [];
let globalVisits = [];
let currentCompanyFilter = "All";
let monthlyChartInstance = null;
let chartDataExport = [];
let activeChatTimer = null;
let clientPollingTimer = null;
let nocPollingTimer = null;
let isFetchingDashboard = false;
let isFetchingClient = false;
let currentSort = { col: 'date', desc: true };

function escapeHTML(str) {
    if (!str) return "";
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

function goTo(pageUrl) {
    window.location.href = pageUrl;
}

async function apiPost(payload) {
    const userActions = [
        "save_user", "register_client", "register_it_staff", "update_user_profile",
        "get_users", "login_admin", "login_client", "delete_user", "reset_password",
        "get_companies", "save_company", "delete_company"
    ];
    let targetUrl = DB_CONFIG.ticketApiUrl;

    if (userActions.includes(payload.action)) {
        targetUrl = DB_CONFIG.userApiUrl;
    } else if (payload.action === 'db_read' || payload.action === 'db_upsert' || payload.action === 'db_delete') {
        if (payload.target_sheet === 'Users' || payload.target_sheet === 'Companies' || payload.target_sheet === 'Settings') {
            targetUrl = DB_CONFIG.userApiUrl;
        }
    }

    try {
        return await fetch(targetUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    } catch (err) { throw err; }
}

function getSLAString(startDateStr, priority, status) {
    if (!startDateStr) return `<span class="text-slate-400">Date Error</span>`;
    if (status === 'Resolved') return `<span class="text-emerald-600 font-bold"><i class="fa-solid fa-check-double mr-1"></i> Resolved</span>`;
    if (status === 'Pending Approval') return `<span class="text-amber-600 font-bold"><i class="fa-solid fa-pause mr-1"></i> SLA Paused</span>`;

    let d = new Date(startDateStr); if (isNaN(d)) d = new Date();
    let slaHours = (priority === 'High') ? 4 : (priority === 'Medium' ? 8 : 24);
    const target = new Date(d.getTime() + (slaHours * 60 * 60 * 1000));
    const diffMs = target - new Date();

    const absMs = Math.abs(diffMs);
    const hrs = Math.floor(absMs / (1000 * 60 * 60));
    const mins = Math.floor((absMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffMs < 0) return `<span class="bg-rose-50 border border-rose-200 text-rose-700 px-2 py-0.5 rounded font-mono text-[10px] font-bold">Breached by ${hrs}h ${mins}m</span>`;
    return `<span class="text-emerald-600 font-bold font-mono text-xs">${hrs}h ${mins}m left</span>`;
}

function validateSession() {
    const storedClient = sessionStorage.getItem('spread_client_session');
    const storedAdmin = sessionStorage.getItem('spread_admin_session');

    if (storedClient) {
        const session = JSON.parse(storedClient);
        if (session.loginTime && (Date.now() - session.loginTime > SESSION_TIMEOUT_MS)) { logoutGlobal(true); }
    }
    if (storedAdmin) {
        const session = JSON.parse(storedAdmin);
        if (session.loginTime && (Date.now() - session.loginTime > SESSION_TIMEOUT_MS)) { logoutGlobal(true); }
    }
}
setInterval(validateSession, 60000);

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;

    const storedClient = sessionStorage.getItem('spread_client_session');
    if (storedClient) clientSession = JSON.parse(storedClient);

    const storedAdmin = sessionStorage.getItem('spread_admin_session');
    if (storedAdmin) {
        const adData = JSON.parse(storedAdmin);
        IT_ROLE = adData.role; IT_NAME = adData.name;
    }
    validateSession();

    if (path.includes('client-dashboard.html') && !clientSession) goTo('client-login.html');
    if (path.includes('admin-dashboard.html') && !IT_ROLE) goTo('admin-login.html');

    if (document.getElementById('clientDashboardView')) {
        document.getElementById('globalLogoutBtn').classList.remove('hidden');
        document.getElementById('clientWelcomeText').innerText = `Logged in as ${clientSession.email}`;
        if (clientSession.role === 'Approver') {
            document.getElementById('approverSection').classList.remove('hidden'); fetchApproverTickets();
        } else { fetchClientTickets(); }
        startClientPolling();
        fetchAppConfig();
    }

    if (document.getElementById('nocDashboardView')) {
        document.getElementById('nocTab-all').innerHTML = `<i class="fa-solid fa-layer-group"></i> Global Queue <span class="text-[10px] ml-2 font-bold px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full border border-blue-200">(${IT_NAME} | ${IT_ROLE})</span>`;
        document.getElementById('globalLogoutBtn').classList.remove('hidden');
        fetchUsersList().then(() => populateVisitCompanies());
        fetchDashboardTickets();
        startNocPolling();
        fetchAppConfig();
    }
});

function logoutGlobal(auto = false) {
    IT_ROLE = ""; IT_NAME = ""; clientSession = null;
    sessionStorage.removeItem('spread_client_session');
    sessionStorage.removeItem('spread_admin_session');
    if (activeChatTimer) { clearInterval(activeChatTimer); activeChatTimer = null; }
    stopClientPolling(); stopNocPolling();
    if (auto) alert("Your session has expired. Please log in again.");
    goTo('index.html');
}

// ==========================================
// DYNAMIC CONFIGURATION & PERFORMANCE ENGINE
// ==========================================
async function fetchAppConfig() {
    try {
        const res = await apiPost({ action: "db_read", target_sheet: "Settings" });
        const data = await res.json();
        
        appConfigData = (data.data || []).map(row => {
            let key = String(row.Key || row.key || "").trim();
            let val = String(row.Value || row.value || "").trim();
            
            if (key.startsWith('Feature_')) {
                return { type: 'FeatureFlag', value: key.replace('Feature_', ''), status: val, default: 'true' };
            }
            return { type: 'Setting', value: key, default: val };
        });

        const tokenSetting = appConfigData.find(c => c.value === 'TelegramBotToken');
        const chatSetting = appConfigData.find(c => c.value === 'TelegramChatId');
        if (tokenSetting && document.getElementById('setBotToken')) document.getElementById('setBotToken').value = tokenSetting.default;
        if (chatSetting && document.getElementById('setChatId')) document.getElementById('setChatId').value = chatSetting.default;

        populateStaticFormDropdowns();
        renderDynamicModuleNav();
        renderFeatureFlagsAdminUI();
        enforceFeatureFlags();
    } catch (e) { console.warn("Failed to load Settings DB."); }
}

async function savePlatformSettings() {
    const token = document.getElementById('setBotToken').value.trim();
    const chatId = document.getElementById('setChatId').value.trim();
    
    try {
        await apiPost({ action: 'db_upsert', target_sheet: 'Settings', primary_key: 'Key', Key: 'TelegramBotToken', Value: token });
        await apiPost({ action: 'db_upsert', target_sheet: 'Settings', primary_key: 'Key', Key: 'TelegramChatId', Value: chatId });
        alert("Platform settings saved to database successfully!");
        fetchAppConfig();
    } catch(e) { alert("Error saving settings."); }
}

function populateStaticFormDropdowns() {
    const isDropdownEnabled = (name) => {
        const flag = appConfigData.find(c => c.type === 'FeatureFlag' && c.value === name);
        return !flag || (flag.status !== 'disabled' && flag.default !== 'false');
    };

    const reqSelect = document.getElementById('requestType');
    if (reqSelect && isDropdownEnabled('RequestTypeDropdown')) {
        const reqTypes = [{value: 'Incident'}, {value: 'Service'}];
        reqSelect.innerHTML = reqTypes.map(r => `<option value="${r.value}">${r.value}</option>`).join('');
        handleRequestTypeChange(); 
    }

    const priSelect = document.getElementById('priority');
    if (priSelect && isDropdownEnabled('PriorityDropdown')) {
        const priorities = [{value: 'Low'}, {value: 'Medium'}, {value: 'High'}];
        priSelect.innerHTML = priorities.map(r => `<option value="${r.value}" ${r.value === 'Medium' ? 'selected' : ''}>${r.value}</option>`).join('');
    }

    const conSelect = document.getElementById('contactMethod');
    if (conSelect && isDropdownEnabled('ContactMethodDropdown')) {
        const contacts = [{value: 'Email'}, {value: 'Phone'}, {value: 'Microsoft Teams'}];
        conSelect.innerHTML = contacts.map(r => `<option value="${r.value}">${r.value}</option>`).join('');
    }
}

function enforceFeatureFlags() {
    const flags = appConfigData.filter(c => c.type === 'FeatureFlag');
    flags.forEach(flag => {
        const isDisabled = flag.status === 'disabled' || flag.default === 'false';

        if (flag.value === 'GlobalQueueTab') {
            const el = document.getElementById('nocTab-all'); if (el) el.style.display = isDisabled ? 'none' : 'flex';
        }
        if (flag.value === 'FieldVisitsTab') {
            const el = document.getElementById('nocTab-visits'); if (el) el.style.display = isDisabled ? 'none' : 'flex';
        }
        if (flag.value === 'AnalyticsTab') {
            const el = document.getElementById('nocTab-analytics'); if (el) el.style.display = isDisabled ? 'none' : 'flex';
        }
        if (flag.value === 'AdminManagementTab') {
            const el = document.getElementById('nocTab-admin'); if (el) el.style.display = isDisabled ? 'none' : 'flex';
        }
        if (flag.value === 'ManagerApprovals') {
            const el = document.getElementById('approverSection'); if (el) el.style.display = isDisabled ? 'none' : 'block';
        }
    });
}

function renderFeatureFlagsAdminUI() {
    const container = document.getElementById('featureFlagsContainer');
    if (!container) return;

    container.style.maxHeight = "380px";
    container.style.overflowY = "auto";
    container.style.paddingRight = "8px";

    const flags = appConfigData.filter(c => c.type === 'FeatureFlag');
    if (flags.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-500">No feature flags configured.</p>`;
        return;
    }

    let html = '';
    flags.forEach(f => {
        const isEnabled = f.status !== 'disabled' && f.default !== 'false';
        html += `
        <div class="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200 rounded-2xl mb-3">
            <div>
                <strong class="text-xs font-bold text-slate-800 block">${escapeHTML(f.value)}</strong>
                <span class="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Portal Control</span>
            </div>
            <label class="itsm-switch">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleFeatureFlag('${escapeHTML(f.value)}', this.checked)">
                <span class="itsm-slider"></span>
            </label>
        </div>`;
    });
    container.innerHTML = html;
}

async function toggleFeatureFlag(flagName, isChecked) {
    const newStatus = isChecked ? 'enabled' : 'disabled';
    const dbKey = `Feature_${flagName}`;
    try {
        await apiPost({
            action: 'db_upsert', target_sheet: 'Settings', primary_key: 'Key',
            Key: dbKey, Value: newStatus
        });
        await fetchAppConfig();
    } catch (e) { alert("Failed to update feature flag."); }
}

function renderDynamicModuleNav() {
    const customModules = appConfigData.filter(c => c.type === 'DynamicModule');
    if (customModules.length === 0) return;

    const navContainer = document.getElementById('dynamicModuleNav');
    if (!navContainer) return;

    let navHTML = '<h3 class="font-black text-slate-800 text-xl mb-4"><i class="fa-solid fa-mobile-screen-button text-indigo-600 mr-2"></i> Auto-Generated Android Modules</h3><div class="flex flex-wrap gap-3">';

    customModules.forEach(mod => {
        navHTML += `<button onclick="loadUniversalTable('${mod.value}')" class="px-5 py-2.5 bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold rounded-full shadow-sm hover:bg-indigo-100 transition active:scale-95"><i class="fa-solid fa-database mr-2"></i> ${mod.value.replace('App_', '')}</button>`;
    });

    navHTML += '</div>';
    navContainer.innerHTML = navHTML;
}

async function loadUniversalTable(sheetName) {
    const container = document.getElementById('universalTableContainer');
    if (!container) return;

    container.innerHTML = `<div class="p-10 text-center text-blue-500"><i class="fa-solid fa-circle-notch fa-spin text-3xl mb-3"></i><p class="font-bold uppercase tracking-wider">Generating Interface for ${sheetName}...</p></div>`;

    try {
        const res = await apiPost({ action: "db_read", target_sheet: sheetName });
        const data = await res.json();
        const rows = data.data || [];

        if (rows.length === 0) {
            container.innerHTML = `<div class="glass-panel p-10 text-center text-slate-500 font-bold uppercase tracking-wider rounded-[24px] bg-white mt-6 border border-slate-200">No records found in ${sheetName}.</div>`;
            return;
        }

        const headers = Object.keys(rows[0]);

        let tableHTML = `
        <div class="glass-panel rounded-[24px] shadow-sm overflow-hidden border border-slate-200 mt-6 bg-white">
            <div class="bg-white p-6 border-b border-slate-200 flex justify-between items-center">
                <h2 class="text-2xl font-black text-slate-800 capitalize"><i class="fa-solid fa-table text-indigo-600 mr-3"></i> ${sheetName.replace('App_', '')} Data</h2>
                <button onclick="loadUniversalTable('${sheetName}')" class="text-sm font-bold text-slate-600 bg-slate-50 border border-slate-200 px-4 py-2 rounded-full shadow-sm hover:bg-slate-100"><i class="fa-solid fa-rotate"></i> Sync</button>
            </div>
            <div class="overflow-x-auto max-h-[600px] relative">
                <table class="w-full text-left text-sm border-collapse">
                    <thead class="table-header-custom">
                        <tr class="text-slate-500 text-[10px] font-black uppercase tracking-widest">`;

        headers.forEach(h => {
            tableHTML += `<th class="px-5 py-5 sticky top-0 bg-slate-50 border-b border-slate-200 whitespace-nowrap">${h.replace(/_/g, ' ')}</th>`;
        });

        tableHTML += `</tr></thead><tbody class="divide-y divide-slate-200">`;

        rows.forEach(row => {
            tableHTML += `<tr class="hover:bg-slate-50 transition-colors">`;
            headers.forEach(h => {
                tableHTML += `<td class="px-5 py-4 whitespace-nowrap text-slate-700 font-medium">${escapeHTML(String(row[h]))}</td>`;
            });
            tableHTML += `</tr>`;
        });

        tableHTML += `</tbody></table></div></div>`;
        container.innerHTML = tableHTML;

    } catch (e) {
        container.innerHTML = `<div class="p-10 text-center text-rose-500 font-bold">Failed to load dynamic module.</div>`;
    }
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
async function handleClientLogin(e) {
    e.preventDefault();
    const email = document.getElementById('clientEmail').value.trim().toLowerCase();
    const pass = document.getElementById('clientPassword').value.trim();
    const btn = e.target.querySelector('button[type="submit"]'); btn.innerHTML = "Verifying..."; btn.disabled = true;
    try {
        const res = await apiPost({ action: 'login_client', email: email, password: pass }); const data = await res.json();
        if (data.status === 'success') {
            clientSession = { email: email, company: data.company, name: data.name, role: data.role, phone: data.phone, peers: data.peers || [], loginTime: Date.now() };
            sessionStorage.setItem('spread_client_session', JSON.stringify(clientSession));
            goTo('client-dashboard.html');
        } else { alert(data.message || "Invalid credentials."); }
    } catch (e) { alert("Database Connection Failed."); }
    btn.innerHTML = "Access Portal"; btn.disabled = false;
}

async function handleITLogin(e) {
    e.preventDefault();
    const email = document.getElementById('itUsername').value.trim().toLowerCase();
    const pass = document.getElementById('itPassword').value.trim();
    const btn = e.target.querySelector('button[type="submit"]'); btn.innerHTML = "Verifying..."; btn.disabled = true;
    try {
        const res = await apiPost({ action: 'login_admin', email: email, password: pass }); const data = await res.json();
        if (data.status === 'success') {
            sessionStorage.setItem('spread_admin_session', JSON.stringify({ role: data.role, name: data.name, loginTime: Date.now() }));
            goTo('admin-dashboard.html');
        } else { alert(data.message || "Invalid credentials."); }
    } catch (e) { alert("Database Connection Failed."); }
    btn.innerHTML = "Login Admin"; btn.disabled = false;
}

// ==========================================
// TAB SWITCHING (DASHBOARDS)
// ==========================================
function switchNocTab(tab) {
    ['all', 'visits', 'analytics', 'admin'].forEach(t => {
        const viewEl = document.getElementById(`noc-${t}View`); const btnEl = document.getElementById(`nocTab-${t}`);
        if (viewEl) viewEl.classList.add('hidden');
        if (btnEl) { btnEl.classList.remove('ent-tab-active'); btnEl.classList.add('ent-tab-inactive'); }
    });
    const activeView = document.getElementById(`noc-${tab}View`); const activeBtn = document.getElementById(`nocTab-${tab}`);
    if (activeView) activeView.classList.remove('hidden');
    if (activeBtn) { activeBtn.classList.remove('ent-tab-inactive'); activeBtn.classList.add('ent-tab-active'); }
    if (tab === 'analytics') renderCompanyGrid();
    if (tab === 'admin') { fetchUsersList(); loadPlatformSettings(); }
    if (tab === 'visits') { fetchUsersList().then(() => populateVisitCompanies()); fetchVisits(); }
}

function switchAdminTab(subTab) {
    ['corp', 'companies', 'it', 'apps'].forEach(t => {
        const viewEl = document.getElementById(`admTab-${t}`); const btnEl = document.getElementById(`admTabBtn-${t}`);
        if (viewEl) viewEl.classList.add('hidden');
        if (btnEl) { btnEl.classList.remove('bg-blue-600', 'text-white', 'border-blue-500/30', 'border'); btnEl.classList.add('glass-surface', 'text-slate-600', 'border-transparent', 'border'); }
    });
    const activeView = document.getElementById(`admTab-${subTab}`); const activeBtn = document.getElementById(`admTabBtn-${subTab}`);
    if (activeView) activeView.classList.remove('hidden');
    if (activeBtn) { activeBtn.classList.remove('glass-surface', 'text-slate-600', 'border-transparent'); activeBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-500/30'); }
    if (subTab === 'companies') renderRegisteredCompanies();
}

function switchClientTicketTab(tab) {
    const activeBtn = document.getElementById('clientTabBtn-active'); const closedBtn = document.getElementById('clientTabBtn-closed');
    const activeContainer = document.getElementById('clientActiveTicketsContainer'); const closedContainer = document.getElementById('clientClosedTicketsContainer');
    if (tab === 'active') {
        activeBtn.className = "px-6 py-2.5 rounded-full text-sm font-bold bg-blue-600 text-white shadow-sm transition whitespace-nowrap";
        closedBtn.className = "px-6 py-2.5 rounded-full text-sm font-bold text-slate-500 hover:text-slate-800 transition whitespace-nowrap";
        activeContainer.classList.remove('hidden'); closedContainer.classList.add('hidden');
    } else {
        closedBtn.className = "px-6 py-2.5 rounded-full text-sm font-bold bg-blue-600 text-white shadow-sm transition whitespace-nowrap";
        activeBtn.className = "px-6 py-2.5 rounded-full text-sm font-bold text-slate-500 hover:text-slate-800 transition whitespace-nowrap";
        closedContainer.classList.remove('hidden'); activeContainer.classList.add('hidden');
    }
}

// ==========================================
// TICKET MODAL & CHAT ENGINE (OPTIMIZED)
// ==========================================
function openTicketModal(ticketId) {
    const ticket = nocDashboardTickets.find(t => t.id === ticketId); if (!ticket) return;
    document.getElementById('modalTicketId').innerText = ticket.id;
    let dDate = "Unknown Date"; if (ticket.date) { const d = new Date(ticket.date); if (!isNaN(d)) dDate = d.toLocaleString(); }
    document.getElementById('modalTicketDate').innerText = dDate;
    document.getElementById('modalRequesterName').innerText = escapeHTML(ticket.name);
    document.getElementById('modalActiveTicketId').value = ticket.id;

    const idx = STATUS_FLOW.indexOf(ticket.status); let pipeHtml = '';
    STATUS_FLOW.forEach((step, i) => {
        let nodeClass = 'node-pending'; let lineClass = '';
        if (i < idx) { nodeClass = 'node-past'; lineClass = 'line-active'; } else if (i === idx) { nodeClass = 'node-active'; }
        pipeHtml += `<div class="pipeline-node ${nodeClass}" title="${step}">${i + 1}</div>`;
        if (i < STATUS_FLOW.length - 1) pipeHtml += `<div class="pipeline-line ${lineClass}"></div>`;
    });
    document.getElementById('modalPipeline').innerHTML = pipeHtml;

    document.getElementById('modalSubject').innerText = escapeHTML(ticket.subject);
    document.getElementById('modalBadges').innerHTML = `
        <span class="px-2 py-0.5 bg-slate-100 border border-slate-200 text-slate-700 rounded text-[10px] font-bold uppercase"><i class="fa-solid fa-building mr-1 text-blue-600"></i> ${escapeHTML(ticket.company)}</span>
        <span class="px-2 py-0.5 bg-blue-50 border border-blue-200 text-blue-700 rounded text-[10px] font-bold uppercase">${escapeHTML(ticket.request_type)}</span>
        <span class="px-2 py-0.5 bg-blue-50 border border-blue-200 text-blue-700 rounded text-[10px] font-bold uppercase">${escapeHTML(ticket.category)}</span>
    `;
    document.getElementById('modalDescription').innerText = ticket.description;

    document.getElementById('modalAttachmentContainer').innerHTML = ticket.attachment && ticket.attachment.startsWith("http")
        ? `<a href="${ticket.attachment}" target="_blank" class="inline-flex items-center px-4 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-blue-600 text-xs font-bold rounded-lg transition"><i class="fa-solid fa-paperclip mr-2"></i> View Attached Evidence</a>` : '';

    document.getElementById('modalRemoteContainer').innerHTML = ticket.remote_support && ticket.remote_support !== 'N/A'
        ? `<div class="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl mt-4"><strong class="block text-[10px] font-black text-rose-600 uppercase tracking-widest mb-1">Remote Access Validation</strong><span class="font-mono text-xs">${escapeHTML(ticket.remote_support)}</span></div>` : '';

    document.getElementById('modalRequesterContact').innerHTML = `${escapeHTML(ticket.email)}<br>${escapeHTML(ticket.phone)}`;
    document.getElementById('modalAssignment').innerText = escapeHTML(ticket.assigned_to) || 'Unassigned';
    document.getElementById('modalAssignDate').innerText = ticket.assigned_date ? 'Assigned: ' + escapeHTML(ticket.assigned_date) : 'Awaiting dispatch';

    if (activeChatTimer) clearInterval(activeChatTimer);
    activeChatTimer = setInterval(() => { refreshJustTheChat(ticketId); }, 4000); // Throttled to 4s for performance
    refreshJustTheChat(ticketId);

    const modal = document.getElementById('ticketModalOverlay');
    if (modal) { modal.classList.remove('hidden'); setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('ticketModal').classList.remove('scale-95'); }, 10); }
}

function closeTicketModal() {
    const modal = document.getElementById('ticketModalOverlay'); if (!modal) return;
    modal.classList.add('opacity-0'); document.getElementById('ticketModal').classList.add('scale-95');
    setTimeout(() => { modal.classList.add('hidden'); }, 200);
    if (activeChatTimer) { clearInterval(activeChatTimer); activeChatTimer = null; }
}

async function refreshJustTheChat(ticketId) {
    try {
        const res = await apiPost({ action: "get_tickets" }); const data = await res.json();
        const updatedTicket = data.tickets.find(t => t.id === ticketId);
        if (updatedTicket) {
            const cacheIndex = nocDashboardTickets.findIndex(t => t.id === ticketId);
            if (cacheIndex > -1) nocDashboardTickets[cacheIndex] = updatedTicket;
            let chatsHTML = '';
            if (updatedTicket.chat_history && updatedTicket.chat_history !== "[]") {
                try {
                    JSON.parse(updatedTicket.chat_history).forEach(c => {
                        const isMe = !(c.sender === updatedTicket.name || c.sender === 'User');
                        const alignClass = isMe ? 'me' : 'them';
                        const senderName = isMe ? '' : `<span class="chat-sender">${escapeHTML(c.sender)}</span>`;
                        chatsHTML += `<div class="chat-bubble-container ${alignClass}"><div class="chat-bubble ${alignClass}">${senderName}<span class="chat-message-text">${escapeHTML(c.message)}</span><span class="chat-meta">${escapeHTML(c.time)}</span></div></div>`;
                    });
                } catch (e) { }
            }
            const chatBox = document.getElementById('modalChatHistory');
            const newHTML = chatsHTML || `<div class="h-full flex items-center justify-center"><p class="text-xs text-slate-500 font-bold uppercase tracking-wider text-center">No messages yet.</p></div>`;
            if (chatBox.innerHTML !== newHTML) { chatBox.innerHTML = newHTML; chatBox.scrollTop = chatBox.scrollHeight; }
        }
    } catch (e) { }
}

async function postModalChatMessage() {
    const input = document.getElementById('modalChatInput'); const ticketId = document.getElementById('modalActiveTicketId').value;
    if (!input.value.trim() || !ticketId) return;
    const payload = { action: 'chat', id: ticketId, sender: IT_NAME || 'IT Support', message: input.value.trim(), time: new Date().toLocaleString() };
    input.value = "Sending..."; input.disabled = true;
    try {
        const res = await apiPost(payload); const data = await res.json();
        if (data.status === "error") { alert("Backend Error: " + data.message); } else { await refreshJustTheChat(ticketId); }
    } catch (e) { alert("Network Error: Failed to reach the database."); }
    input.disabled = false; input.value = ''; input.focus();
}

// ==========================================
// CLIENT DASHBOARD ENGINE (OPTIMIZED)
// ==========================================
function startClientPolling() {
    if (clientPollingTimer) clearInterval(clientPollingTimer);
    clientPollingTimer = setInterval(refreshClientDashboardSilently, 4000); // Optimized to 4s
}

function stopClientPolling() {
    if (clientPollingTimer) { clearInterval(clientPollingTimer); clientPollingTimer = null; }
}

async function refreshClientDashboardSilently() {
    if (!clientSession || isFetchingClient) return;
    isFetchingClient = true;
    try {
        const res = await apiPost({ action: "get_tickets" }); let data = await res.json();
        let tickets = data.tickets || [];
        tickets = tickets.filter(t => t.id && t.email && t.email.toLowerCase() === clientSession.email.toLowerCase());

        tickets.forEach(t => {
            const chatBox = document.getElementById(`clientChatHistory_${t.id}`);
            if (chatBox) {
                let chatsHTML = '';
                if (t.chat_history && t.chat_history !== "[]") {
                    try {
                        JSON.parse(t.chat_history).forEach(c => {
                            const isMe = (c.sender === t.name || c.sender === 'User' || c.sender === clientSession.name);
                            const alignClass = isMe ? 'me' : 'them';
                            const senderName = isMe ? '' : `<span class="chat-sender">${escapeHTML(c.sender)}</span>`;
                            chatsHTML += `<div class="chat-bubble-container ${alignClass}"><div class="chat-bubble ${alignClass}">${senderName}<span class="chat-message-text">${escapeHTML(c.message)}</span><span class="chat-meta">${escapeHTML(c.time)}</span></div></div>`;
                        });
                    } catch (e) { }
                }
                const newHTML = chatsHTML || '<div class="h-full flex items-center justify-center"><p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center">No messages yet.</p></div>';
                if (chatBox.innerHTML !== newHTML) { chatBox.innerHTML = newHTML; chatBox.scrollTop = chatBox.scrollHeight; }
            }

            const statusBadge = document.getElementById(`clientStatusBadge_${t.id}`);
            if (statusBadge && statusBadge.innerText !== t.status) { statusBadge.innerText = t.status; }

            const slaContainer = document.getElementById(`clientSlaText_${t.id}`);
            if (slaContainer) {
                const dynamicSla = getSLAString(t.date, t.priority, t.status);
                let slaText = `<span class="text-amber-600 font-bold"><i class="fa-solid fa-clock"></i> Logged. Awaiting IT Assignment. <br>Target: ${dynamicSla}</span>`;
                if (t.assigned_to) {
                    slaText = `<span class="text-emerald-600 font-bold"><i class="fa-solid fa-user-check"></i> Assigned to ${escapeHTML(t.assigned_to)}</span>`;
                    if (t.status === "Working") slaText += `<br><span class="text-blue-600 font-bold"><i class="fa-solid fa-spinner fa-spin"></i> IT is actively working on this... <br>Target: ${dynamicSla}</span>`;
                    if (t.status === "Resolved") slaText = `<span class="text-emerald-600 font-bold"><i class="fa-solid fa-check-double"></i> Ticket Resolved</span>`;
                }
                if (slaContainer.innerHTML !== slaText) slaContainer.innerHTML = slaText;
            }
        });
    } catch (e) { }
    isFetchingClient = false;
}

async function postClientChatMessage(ticketId) {
    const input = document.getElementById(`chatInput_${ticketId}`); if (!input.value.trim()) return;
    const payload = { action: 'chat', id: ticketId, sender: clientSession ? clientSession.name : 'User', message: input.value.trim(), time: new Date().toLocaleString() };
    input.value = "Sending..."; input.disabled = true;
    try {
        const res = await apiPost(payload); const data = await res.json();
        if (data.status === "error") { alert("Backend Error: " + data.message); } else { await refreshClientDashboardSilently(); }
    } catch (e) { alert("Network Error: Failed to reach the database."); }
    input.disabled = false; input.value = ''; input.focus();
}

function generateClientTicketCard(t) {
    const dynamicSla = getSLAString(t.date, t.priority, t.status);
    let displayDate = "Unknown Date"; if (t.date) { const d = new Date(t.date); if (!isNaN(d)) displayDate = d.toLocaleString(); }

    let slaText = `<span class="text-amber-600 font-bold"><i class="fa-solid fa-clock"></i> Logged. Awaiting IT Assignment. <br>Target: ${dynamicSla}</span>`;
    if (t.assigned_to) {
        slaText = `<span class="text-emerald-600 font-bold"><i class="fa-solid fa-user-check"></i> Assigned to ${escapeHTML(t.assigned_to)}</span>`;
        if (t.status === "Working") slaText += `<br><span class="text-blue-600 font-bold"><i class="fa-solid fa-spinner fa-spin"></i> IT is actively working on this... <br>Target: ${dynamicSla}</span>`;
        if (t.status === "Resolved") slaText = `<span class="text-emerald-600 font-bold"><i class="fa-solid fa-check-double"></i> Ticket Resolved</span>`;
    }

    let chatsHTML = '';
    if (t.chat_history && t.chat_history !== "[]") {
        try { JSON.parse(t.chat_history).forEach(c => { const isMe = (c.sender === t.name || c.sender === 'User' || c.sender === clientSession.name); const alignClass = isMe ? 'me' : 'them'; const senderName = isMe ? '' : `<span class="chat-sender">${escapeHTML(c.sender)}</span>`; chatsHTML += `<div class="chat-bubble-container ${alignClass}"><div class="chat-bubble ${alignClass}">${senderName}<span class="chat-message-text">${escapeHTML(c.message)}</span><span class="chat-meta">${escapeHTML(c.time)}</span></div></div>`; }); } catch (e) { }
    }

    let attachBadge = (t.attachment && t.attachment.startsWith("http")) ? `<a href="${t.attachment}" target="_blank" class="mt-3 inline-block text-[10px] text-blue-600 hover:text-blue-500 transition underline"><i class="fa-solid fa-paperclip"></i> View Uploaded File</a>` : '';

    return `
    <div class="glass-surface rounded-[20px] shadow-sm hover:shadow-md transition-shadow border border-slate-200 overflow-hidden bg-white flex flex-col lg:flex-row w-full">
        <div class="w-full lg:w-7/12 p-6 flex flex-col border-b lg:border-b-0 lg:border-r border-slate-200 relative">
            <div class="flex justify-between items-start mb-4">
                <div><span class="font-black text-blue-600 text-lg">${t.id}</span><span id="clientStatusBadge_${t.id}" class="ml-2 text-[9px] px-2.5 py-0.5 bg-slate-100 border border-slate-200 text-slate-700 rounded-full font-bold uppercase tracking-wider">${t.status}</span></div>
                <div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider text-right">${displayDate}</div>
            </div>
            <h4 class="font-extrabold text-base mb-3 text-slate-800 leading-tight pr-4">${escapeHTML(t.subject)}</h4>
            <div class="flex gap-2 mb-4 flex-wrap">
                <span class="text-[9px] bg-blue-50 border border-blue-200 text-blue-700 px-2 py-1 rounded font-bold uppercase">${escapeHTML(t.request_type)}</span>
                <span class="text-[9px] bg-blue-50 border border-blue-200 text-blue-700 px-2 py-1 rounded font-bold uppercase">${escapeHTML(t.category)}</span>
                <span class="text-[9px] bg-slate-100 border border-slate-200 text-slate-700 px-2 py-1 rounded font-bold uppercase">Impact: ${escapeHTML(t.impact_level)}</span>
            </div>
            <div class="bg-slate-50 p-4 rounded-xl text-xs mb-4 border border-slate-200 flex-grow"><p class="text-slate-700 whitespace-pre-wrap leading-relaxed">${escapeHTML(t.description)}</p>${attachBadge}</div>
            <div class="glass-surface p-4 rounded-xl text-xs border border-slate-200 bg-slate-50 mt-auto"><strong class="uppercase text-[9px] text-slate-500 tracking-wider mb-1 block">Ticket Activity:</strong><div id="clientSlaText_${t.id}" class="text-xs">${slaText}</div></div>
        </div>
        <div class="w-full lg:w-5/12 flex flex-col bg-slate-50 h-[350px] lg:h-auto">
            <div class="p-4 border-b border-slate-200 bg-white flex justify-between items-center"><h5 class="text-[10px] font-bold uppercase tracking-wider text-slate-600 flex items-center"><i class="fa-brands fa-whatsapp mr-2 text-emerald-500 text-lg"></i> Support Chat</h5></div>
            <div id="clientChatHistory_${t.id}" class="flex-grow p-4 overflow-y-auto flex flex-col space-y-2 scroll-smooth chat-bg">${chatsHTML || '<div class="h-full flex items-center justify-center"><p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center">No messages yet.</p></div>'}</div>
            <div class="p-4 glass-surface border-t border-slate-200 bg-white mt-auto"><div class="flex gap-2 relative"><input type="text" id="chatInput_${t.id}" onkeypress="if(event.key === 'Enter') postClientChatMessage('${t.id}')" class="flex-grow px-4 py-2.5 text-xs bg-white border border-slate-300 rounded-full outline-none focus:border-blue-500 text-slate-800" placeholder="Reply to IT..."><button onclick="postClientChatMessage('${t.id}')" class="bg-blue-600 text-white w-10 h-10 rounded-full flex items-center justify-center shadow-md hover:bg-blue-500 active:scale-95 transition-all flex-shrink-0"><i class="fa-solid fa-paper-plane text-xs"></i></button></div></div>
        </div>
    </div>`;
}

async function fetchClientTickets() {
    const activeContainer = document.getElementById('clientActiveTicketsContainer'); const closedContainer = document.getElementById('clientClosedTicketsContainer');
    if (!clientSession || !activeContainer || !closedContainer) return;
    activeContainer.innerHTML = '<div class="text-center py-10 w-full"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-blue-500 mb-3"></i><p class="font-bold text-slate-500">Syncing...</p></div>'; closedContainer.innerHTML = '';
    try {
        const res = await apiPost({ action: "get_tickets" }); let data = await res.json(); let tickets = data.tickets || [];
        tickets = tickets.filter(t => t.id && t.email && t.email.toLowerCase() === clientSession.email.toLowerCase()).reverse();
        const activeTickets = tickets.filter(t => t.status !== 'Resolved'); const closedTickets = tickets.filter(t => t.status === 'Resolved');

        if (activeTickets.length === 0) { activeContainer.innerHTML = '<div class="text-center py-10 text-slate-500 font-bold uppercase tracking-wider w-full">No active requests found.</div>'; } else { activeContainer.innerHTML = activeTickets.map(t => generateClientTicketCard(t)).join(''); }
        if (closedTickets.length === 0) { closedContainer.innerHTML = '<div class="text-center py-10 text-slate-500 font-bold uppercase tracking-wider w-full">No closed requests found.</div>'; } else { closedContainer.innerHTML = closedTickets.map(t => generateClientTicketCard(t)).join(''); }
        tickets.forEach(t => { const chatBox = document.getElementById(`clientChatHistory_${t.id}`); if (chatBox) chatBox.scrollTop = chatBox.scrollHeight; });
    } catch (e) { activeContainer.innerHTML = '<div class="text-rose-600 font-bold w-full">Error loading tickets.</div>'; }
}

async function fetchApproverTickets() {
    const container = document.getElementById('approverTicketsContainer'); if (!container) return;
    container.innerHTML = '<div class="text-center py-6 text-amber-600 font-bold"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Loading pending approvals...</div>';
    try {
        const res = await apiPost({ action: "get_tickets" }); let data = await res.json(); let tickets = data.tickets || [];
        tickets = tickets.filter(t => t.id && t.company === clientSession.company && t.status === "Pending Approval").reverse();
        if (tickets.length === 0) { container.innerHTML = '<div class="text-center py-6 text-emerald-600 font-extrabold uppercase tracking-wider"><i class="fa-solid fa-check-circle mr-2"></i> All caught up. No pending requests.</div>'; return; }
        let htmlStr = '';
        tickets.forEach(t => {
            htmlStr += `
                <div class="glass-panel border-amber-300 rounded-xl p-5 shadow-sm transition bg-amber-50">
                    <div class="flex justify-between items-start mb-3">
                        <div><span class="font-extrabold text-amber-700 text-lg">${escapeHTML(t.subject)}</span><br><span class="text-xs font-bold text-amber-600 uppercase tracking-wider">Requested by: ${escapeHTML(t.name)}</span></div>
                        <span class="text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-300 px-3 py-1 rounded-full">${t.id}</span>
                    </div>
                    <div class="bg-white p-4 rounded-lg border border-amber-200 mb-4"><p class="text-xs text-amber-800 font-medium whitespace-pre-wrap">${escapeHTML(t.description)}</p></div>
                    <div class="flex gap-3 justify-end">
                        <button onclick="managerApproveReject('${t.id}', 'Rejected')" class="glass-surface border border-rose-300 text-rose-600 hover:bg-rose-50 px-6 py-2.5 rounded-full text-xs font-bold transition active:scale-95">Reject</button>
                        <button onclick="managerApproveReject('${t.id}', 'Monitoring')" class="bg-emerald-600 border border-emerald-500 text-white hover:bg-emerald-500 px-6 py-2.5 rounded-full text-xs font-bold transition active:scale-95">Approve Request</button>
                    </div>
                </div>`;
        });
        container.innerHTML = htmlStr;
    } catch (e) { container.innerHTML = '<div class="text-rose-600 text-sm font-bold">Failed to load approvals.</div>'; }
}

async function managerApproveReject(ticketId, newStatus) {
    try { await apiPost({ action: 'update', id: ticketId, status: newStatus }); alert(`Ticket ${ticketId} has been ${newStatus === 'Monitoring' ? 'Approved' : 'Rejected'}.`); fetchApproverTickets(); fetchClientTickets(); }
    catch (e) { alert("Network Error updating ticket."); }
}

// ==========================================
// MASTER NOC ENGINE (OPTIMIZED)
// ==========================================
function startNocPolling() {
    if (nocPollingTimer) clearInterval(nocPollingTimer);
    nocPollingTimer = setInterval(refreshNOCDashboardSilently, 4000); // Throttled to 4s for zero laptop lag
}

function stopNocPolling() {
    if (nocPollingTimer) { clearInterval(nocPollingTimer); nocPollingTimer = null; }
}

async function refreshNOCDashboardSilently() {
    if (!IT_ROLE || isFetchingDashboard) return;
    isFetchingDashboard = true;
    try {
        const res = await apiPost({ action: "get_tickets" }); const data = await res.json();
        let newTickets = data.tickets || []; newTickets = newTickets.filter(t => t && t.id);
        const currentStr = JSON.stringify(nocDashboardTickets.map(t => ({ status: t.status, assigned_to: t.assigned_to, chat_history: t.chat_history })));
        const newStr = JSON.stringify(newTickets.reverse().map(t => ({ status: t.status, assigned_to: t.assigned_to, chat_history: t.chat_history })));

        if (currentStr !== newStr) {
            const checkedIds = Array.from(document.querySelectorAll('.ticket-checkbox:checked')).map(cb => cb.value);
            nocDashboardTickets = newTickets;
            document.getElementById('kpiTotal').innerText = nocDashboardTickets.length;
            document.getElementById('kpiUnassigned').innerText = nocDashboardTickets.filter(t => !t.assigned_to || t.assigned_to.trim() === "").length;
            document.getElementById('kpiOpen').innerText = nocDashboardTickets.filter(t => t.status === "Pending Approval" || t.status === "Monitoring").length;
            document.getElementById('kpiAssigned').innerText = nocDashboardTickets.filter(t => t.status === "Assigned").length;
            document.getElementById('kpiWorking').innerText = nocDashboardTickets.filter(t => t.status === "Working").length;
            document.getElementById('kpiResolved').innerText = nocDashboardTickets.filter(t => t.status === "Resolved").length;
            updateChart(nocDashboardTickets); filterDashboard();
            checkedIds.forEach(id => { const cb = document.querySelector(`.ticket-checkbox[value="${id}"]`); if (cb) cb.checked = true; });
        }
    } catch (e) { }
    isFetchingDashboard = false;
}

async function fetchDashboardTickets() {
    const tbody = document.getElementById('dashboardTableBody'); if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="p-10 text-center"><i class="fa-solid fa-circle-notch fa-spin text-3xl text-blue-500"></i></td></tr>`;
    try {
        const res = await apiPost({ action: "get_tickets" }); const data = await res.json();
        nocDashboardTickets = data.tickets || []; nocDashboardTickets = nocDashboardTickets.filter(t => t && t.id).reverse();
        document.getElementById('kpiTotal').innerText = nocDashboardTickets.length;
        document.getElementById('kpiUnassigned').innerText = nocDashboardTickets.filter(t => !t.assigned_to || t.assigned_to.trim() === "").length;
        document.getElementById('kpiOpen').innerText = nocDashboardTickets.filter(t => t.status === "Pending Approval" || t.status === "Monitoring").length;
        document.getElementById('kpiAssigned').innerText = nocDashboardTickets.filter(t => t.status === "Assigned").length;
        document.getElementById('kpiWorking').innerText = nocDashboardTickets.filter(t => t.status === "Working").length;
        document.getElementById('kpiResolved').innerText = nocDashboardTickets.filter(t => t.status === "Resolved").length;
        updateChart(nocDashboardTickets); filterDashboard();
    } catch (e) { tbody.innerHTML = `<tr><td colspan="5" class="p-10 text-center text-rose-500 font-bold">API Connection Error. Ensure DB is published.</td></tr>`; }
}

function setQuickFilter(status) {
    const filterDropdown = document.getElementById('dashStatusFilter');
    if (filterDropdown) { filterDropdown.value = status; filterDashboard(); }
}

function sortTable(column) {
    if (currentSort.col === column) { currentSort.desc = !currentSort.desc; } else { currentSort.col = column; currentSort.desc = (column === 'date' || column === 'id'); }
    document.querySelectorAll('.sort-icon').forEach(icon => { icon.className = 'fa-solid fa-sort sort-icon'; });
    const activeIcon = document.getElementById(`sortIcon_${column}`);
    if (activeIcon) { activeIcon.className = `fa-solid fa-sort-${currentSort.desc ? 'down' : 'up'} sort-icon sort-active`; }
    filterDashboard();
}

function toggleAllCheckboxes(source) {
    const checkboxes = document.querySelectorAll('.ticket-checkbox'); checkboxes.forEach(cb => cb.checked = source.checked);
}

async function bulkDeleteTickets() {
    const checkboxes = document.querySelectorAll('.ticket-checkbox:checked');
    if (checkboxes.length === 0) return alert("Select tickets to delete.");
    if (!confirm(`Delete ${checkboxes.length} ticket(s) permanently?`)) return;
    for (let cb of checkboxes) { await apiPost({ action: 'delete_ticket', id: cb.value }); }
    alert("Tickets disposed."); document.getElementById('selectAllCheckbox').checked = false; fetchDashboardTickets();
}

async function deleteTicket(ticketId) {
    if (!confirm(`Are you sure you want to permanently delete ticket ${ticketId}?`)) return;
    try { await apiPost({ action: 'delete_ticket', id: ticketId }); fetchDashboardTickets(); } catch (e) { alert("Error deleting ticket."); }
}

function filterByCompany(company) {
    currentCompanyFilter = company; switchNocTab('all');
    const filterWrapper = document.createElement('div'); filterWrapper.id = "activeFilterWrapper"; filterWrapper.className = "flex items-center bg-blue-50 border border-blue-200 text-blue-700 px-4 py-1.5 rounded-full text-xs font-bold mr-3 shadow-sm"; filterWrapper.innerHTML = `<span id="activeFilterBadge">${company}</span><button onclick="clearCompanyFilter()" class="ml-3 hover:text-rose-500 transition-colors"><i class="fa-solid fa-times"></i></button>`;
    const headerActions = document.getElementById('queueHeaderActions'); const existing = document.getElementById('activeFilterWrapper');
    if (existing) existing.remove(); if (headerActions) headerActions.appendChild(filterWrapper); filterDashboard();
}

function clearCompanyFilter() {
    currentCompanyFilter = "All"; const existing = document.getElementById('activeFilterWrapper'); if (existing) existing.remove(); filterDashboard();
}

function filterDashboard() {
    const filter = document.getElementById('dashStatusFilter')?.value || "All"; const search = document.getElementById('dashSearch')?.value.toLowerCase() || "";
    let filtered = nocDashboardTickets.filter(t => {
        if (!t.id) return false;
        const mFilter = (filter === 'All') ? true : (filter === 'Unassigned') ? (!t.assigned_to || t.assigned_to.trim() === '') : (t.status === filter);
        const mSearch = String(t.id).toLowerCase().includes(search) || String(t.name).toLowerCase().includes(search) || String(t.subject).toLowerCase().includes(search);
        const mComp = (currentCompanyFilter === 'All' || (t.company && t.company === currentCompanyFilter));
        return mFilter && mSearch && mComp;
    });
    filtered.sort((a, b) => {
        let valA = a[currentSort.col] || ''; let valB = b[currentSort.col] || '';
        if (currentSort.col === 'id') { valA = parseInt((a.id || '').replace(/[^0-9]/g, '')) || 0; valB = parseInt((b.id || '').replace(/[^0-9]/g, '')) || 0; }
        if (valA < valB) return currentSort.desc ? 1 : -1;
        if (valA > valB) return currentSort.desc ? -1 : 1;
        return 0;
    });

    filteredTicketsCache = filtered; const tbody = document.getElementById('dashboardTableBody'); if (!tbody) return; tbody.innerHTML = '';

    if (filtered.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="p-10 text-center text-slate-500 font-bold uppercase tracking-wider">No tickets match this view.</td></tr>`; return; }

    let htmlStr = '';
    filtered.forEach(t => {
        const isPending = (t.status === 'Pending Approval'); const canApprove = (IT_ROLE === 'Master Admin' || IT_ROLE === 'Approver');
        let selectHTML = `<select onchange="updateAdminTicketStatus('${t.id}', this.value)" class="p-2 border border-slate-300 rounded-lg text-[11px] font-bold bg-white text-slate-800 w-full outline-none cursor-pointer shadow-sm" ${isPending && !canApprove ? 'disabled' : ''}>`;
        STATUS_FLOW.forEach(s => { selectHTML += `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`; }); selectHTML += `</select>`;

        const dynamicSla = getSLAString(t.date, t.priority, t.status); let displayDate = "Unknown Date"; if (t.date) { const d = new Date(t.date); if (!isNaN(d)) displayDate = d.toLocaleString(); }

        let assignSelect = "";
        if (t.status !== 'Resolved') {
            if (IT_ROLE === 'Master Admin') {
                assignSelect = `<select onchange="assignTicketToUser('${t.id}', this.value)" class="mt-2 p-1.5 w-full bg-slate-50 border border-slate-200 rounded text-xs font-bold text-slate-700 outline-none cursor-pointer"><option value="" ${(!t.assigned_to || t.assigned_to === "") ? "selected" : ""}>Unassigned</option>`;
                globalUsersList.forEach(u => { if (u.role === 'Master Admin' || u.role === 'Tier 1 Support') { assignSelect += `<option value="${escapeHTML(u.name)}" ${(t.assigned_to === u.name) ? 'selected' : ''}>${escapeHTML(u.name)}</option>`; } });
                assignSelect += `</select>`;
            } else {
                if (!t.assigned_to || t.assigned_to === "") { assignSelect = `<button onclick="assignTicketToUser('${t.id}', '${IT_NAME}')" class="text-[10px] bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-blue-500 transition block mt-2 w-full text-center shadow-md active:scale-95">Assign to Me</button>`; }
                else if (t.assigned_to === IT_NAME) { assignSelect = `<button onclick="assignTicketToUser('${t.id}', '')" class="text-[10px] bg-slate-100 text-slate-600 border border-slate-200 px-3 py-1 rounded-lg font-bold hover:bg-slate-200 transition block mt-2 w-full text-center">Unassign Ticket</button>`; }
            }
        }

        let slaBadge = `<span class="text-[10px] font-bold block ${t.assigned_to ? 'text-emerald-600' : 'text-amber-600'} mb-1">${t.assigned_to ? ('Assigned to: ' + escapeHTML(t.assigned_to)) : 'Unassigned'}</span><span class="text-[10px] font-bold block">${dynamicSla}</span>${assignSelect}`;
        let remoteBadge = '';
        if (t.remote_support && t.remote_support !== 'N/A' && t.remote_support.trim() !== '') { remoteBadge = `<div class="mt-3 p-2 bg-rose-50 border border-rose-200 rounded-lg shadow-sm w-max"><span class="text-[9px] font-black text-rose-600 uppercase tracking-widest block mb-0.5"><i class="fa-solid fa-desktop mr-1"></i> Remote Access</span><span class="text-xs font-mono font-bold text-rose-700">${escapeHTML(t.remote_support)}</span></div>`; }
        let attachBadge = t.attachment && t.attachment.startsWith("http") ? `<a href="${t.attachment}" target="_blank" class="mt-2 inline-block text-[10px] text-blue-600 hover:text-blue-500 transition underline"><i class="fa-solid fa-paperclip"></i> View File</a>` : '';

        htmlStr += `
            <tr class="hover:bg-slate-50 border-b border-slate-200 transition-colors">
                <td class="px-5 py-5 text-center"><input type="checkbox" class="ticket-checkbox w-4 h-4 cursor-pointer accent-blue-600" value="${t.id}"></td>
                <td class="px-5 py-5 align-top"><button onclick="openTicketModal('${t.id}')" class="font-black text-blue-600 hover:underline text-sm block mb-1 text-left">${t.id}</button><span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider whitespace-nowrap">${displayDate}</span></td>
                <td class="px-6 py-5 align-top w-36">${slaBadge}</td>
                <td class="px-6 py-5 align-top text-sm"><strong class="block text-slate-800 mb-1 truncate max-w-sm">${escapeHTML(t.subject)}</strong><span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">${escapeHTML(t.company)}</span><span class="text-[10px] text-slate-400 ml-1">| ${escapeHTML(t.name)}</span>${attachBadge}${remoteBadge}</td>
                <td class="px-6 py-5 align-top w-40">${selectHTML}<div class="flex justify-between mt-3 gap-2"><button onclick="openTicketModal('${t.id}')" class="w-full text-[10px] bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200 py-1.5 rounded-lg font-bold transition">Open View</button>${IT_ROLE === 'Master Admin' ? `<button onclick="deleteTicket('${t.id}')" class="w-10 flex items-center justify-center text-[10px] bg-rose-50 border border-rose-200 text-rose-600 hover:bg-rose-100 py-1.5 rounded-lg transition"><i class="fa-solid fa-trash"></i></button>` : ''}</div></td>
            </tr>`;
    });
    tbody.innerHTML = htmlStr;
}

async function assignTicketToUser(ticketId, assignedUser) {
    const t = nocDashboardTickets.find(x => x.id === ticketId); if (!t) return;
    let newStatus = t.status;
    if (assignedUser !== "") { if (t.status === 'Monitoring' || t.status === 'Pending Approval') newStatus = 'Assigned'; } else { if (t.status === 'Assigned') newStatus = (t.request_type === 'Service') ? 'Pending Approval' : 'Monitoring'; }
    try { await apiPost({ action: 'update', id: ticketId, status: newStatus, assigned_to: assignedUser, assigned_date: new Date().toLocaleString() }); fetchDashboardTickets(); } catch (e) { }
}

async function updateAdminTicketStatus(ticketId, newStatus) {
    let rca = "";
    if (newStatus === "Resolved") { rca = prompt(`Please enter the Root Cause Analysis (RCA) or resolution details for ${ticketId}:`); if (!rca) { alert("RCA is required to close a ticket."); return fetchDashboardTickets(); } }
    try { await apiPost({ action: 'update', id: ticketId, status: newStatus, resolve_description: escapeHTML(rca) }); fetchDashboardTickets(); } catch (e) { }
}

// ==========================================
// FIELD VISITS ENGINE (STRICT SCHEMA MATCH)
// ==========================================
function populateVisitCompanies() {
    const compSelect = document.getElementById('visitCompany');
    if (compSelect && globalRegisteredCompanies.length > 0) {
        let html = '<option value="" disabled selected>Select Client Company</option>';
        globalRegisteredCompanies.forEach(c => { const cName = escapeHTML(c.company || c["company name"] || c.name); html += `<option value="${cName}">${cName}</option>`; });
        compSelect.innerHTML = html;
    }
}

async function fetchVisits() {
    try {
        const res = await apiPost({ action: 'db_read', target_sheet: 'Visits' }); const data = await res.json();
        globalVisits = data.data || []; renderVisits();
    } catch (e) { }
}

function getLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                document.getElementById('visitLat').value = position.coords.latitude;
                document.getElementById('visitLng').value = position.coords.longitude;
                alert("GPS Coordinates captured successfully!");
            },
            (err) => {
                console.warn(err);
                alert("Could not fetch location. Please ensure location services are enabled on this device.");
            }
        );
    } else {
        alert("Geolocation is not supported by this browser.");
    }
}

function renderVisits() {
    const container = document.getElementById('visitLogsContainer'); if (!container) return;
    if (globalVisits.length === 0) { container.innerHTML = '<p class="text-sm font-bold uppercase tracking-wider text-slate-500 text-center py-10">No visits recorded.</p>'; return; }

    let sorted = [...globalVisits].sort((a, b) => {
        let dA = a.time_in || a.date || a.time_out || 0;
        let dB = b.time_in || b.date || b.time_out || 0;
        return new Date(dB) - new Date(dA);
    });

    let html = '';
    sorted.forEach(v => {
        let isCompleted = (v.time_out && v.time_out.trim() !== "");
        let statColor = isCompleted ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-amber-700 bg-amber-50 border-amber-200';
        let statusText = isCompleted ? 'Completed' : 'Ongoing';
        
        let mapLink = v.latitude && v.longitude 
            ? `https://www.google.com/maps/search/?api=1&query=${v.latitude},${v.longitude}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.address || v.company)}`;

        const formatDate = (dateStr) => {
            if (!dateStr) return null;
            let d = new Date(dateStr);
            return isNaN(d) ? dateStr : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        };

        let scheduleDisplay = formatDate(v.date) || "No Schedule Date";
        let inDisplay = formatDate(v.time_in) || "Not Started";
        let exitDisplay = formatDate(v.time_out) || "Pending";
        
        let durationDisplay = v.duration ? `<span class="text-blue-600 font-black"><i class="fa-solid fa-stopwatch mr-1 text-blue-500"></i> ${escapeHTML(v.duration)}</span>` : '<span class="text-slate-400 font-medium">Ongoing</span>';

        html += `
        <div class="p-5 bg-white border border-slate-200 rounded-[20px] flex flex-col hover:shadow-md transition-all gap-3 relative overflow-hidden">
            <div class="flex justify-between items-start">
                <h4 class="font-black text-sm text-slate-800 flex items-center flex-wrap gap-2">
                    ${escapeHTML(v.company)} 
                    <span class="px-2 py-0.5 rounded text-[9px] font-bold border ${statColor}">${statusText}</span> 
                </h4>
                <span class="text-[10px] text-slate-500 font-bold whitespace-nowrap">${scheduleDisplay}</span>
            </div>
            
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-slate-50 border border-slate-100 rounded-xl p-3 shadow-inner">
                <div>
                    <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">In Time</span>
                    <span class="text-xs font-bold text-slate-700 whitespace-nowrap">${inDisplay}</span>
                </div>
                <div>
                    <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Out Time</span>
                    <span class="text-xs font-bold text-slate-700 whitespace-nowrap">${exitDisplay}</span>
                </div>
                <div class="col-span-2 sm:col-span-1 sm:text-right">
                    <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Duration</span>
                    <span class="text-sm">${durationDisplay}</span>
                </div>
            </div>

            <div class="flex flex-col gap-1">
                <p class="text-xs text-slate-600 font-medium"><i class="fa-solid fa-bullseye mr-1 w-4 text-center text-slate-400"></i> ${escapeHTML(v.device_details || v.purpose || "General Support")}</p>
            </div>

            <div class="flex items-center justify-between mt-1 pt-3 border-t border-slate-100">
                <a href="${mapLink}" target="_blank" class="text-[10px] font-bold text-slate-500 hover:text-blue-600 transition truncate pr-4">
                    <i class="fa-solid fa-map-location-dot mr-1 text-blue-500"></i> ${escapeHTML(v.address || "Open Map")}
                </a>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

async function saveVisitLog(e) {
    e.preventDefault(); const btn = document.getElementById('btnSaveVisit'); btn.innerHTML = "Saving..."; btn.disabled = true;
    let vId = document.getElementById('visitId').value; if (!vId) vId = "VISIT-" + Date.now();

    const payload = {
        action: 'db_upsert', target_sheet: 'Visits', primary_key: 'id',
        id: vId,
        company: document.getElementById('visitCompany').value,
        technician: IT_NAME,
        date: document.getElementById('visitDate').value,
        time_in: "",
        time_out: "",
        duration: "",
        device_details: document.getElementById('visitDeviceDetails').value.trim(),
        photo_url: "",
        documents: "",
        address: document.getElementById('visitAddress').value.trim(),
        latitude: document.getElementById('visitLat').value.trim(),
        longitude: document.getElementById('visitLng').value.trim(),
        client_phone: document.getElementById('visitClientPhone').value.trim(),
        client_contact: document.getElementById('visitClientContact').value.trim(),
        status: document.getElementById('visitStatus').value, 
        notes: document.getElementById('visitNotes').value.trim()
    };

    try { await apiPost(payload); clearVisitForm(); fetchVisits(); } catch (e) { alert("Network error saving visit."); }
    btn.innerHTML = "Save Log"; btn.disabled = false;
}

function clearVisitForm() {
    document.getElementById('visitId').value = ''; 
    document.getElementById('visitLat').value = ''; 
    document.getElementById('visitLng').value = ''; 
    document.getElementById('visitCompany').value = ''; 
    document.getElementById('visitAddress').value = ''; 
    document.getElementById('visitDate').value = ''; 
    document.getElementById('visitClientContact').value = ''; 
    document.getElementById('visitClientPhone').value = ''; 
    document.getElementById('visitDeviceDetails').value = ''; 
    document.querySelectorAll('#noc-visitsView .itsm-input').forEach(i => i.classList.remove('has-val'));
}

async function deleteVisit(id) {
    if (!confirm("Delete this visit log permanently?")) return;
    try { await apiPost({ action: 'db_delete', target_sheet: 'Visits', primary_key: 'id', primary_value: id }); fetchVisits(); } catch (e) { alert("Error deleting log."); }
}

function autoFillVisitDetails() {
    const compName = document.getElementById('visitCompany').value;
    if (!compName) return;

    const comp = globalRegisteredCompanies.find(c => (c.company || c["company name"] || c.name) === compName);
    if (comp) {
        const locInput = document.getElementById('visitAddress'); 
        locInput.value = comp.address || ''; 
        if(locInput.value) locInput.classList.add('has-val');

        const contactInput = document.getElementById('visitClientContact');
        contactInput.value = comp.it_contact || '';
        if(contactInput.value) contactInput.classList.add('has-val');

        const phoneInput = document.getElementById('visitClientPhone');
        phoneInput.value = comp.phone || '';
        if(phoneInput.value) phoneInput.classList.add('has-val');
    }

    const dateInput = document.getElementById('visitDate');
    const now = new Date(); const tzOffset = now.getTimezoneOffset() * 60000;
    
    dateInput.value = new Date(now.getTime() - tzOffset).toISOString().slice(0, 16);
    dateInput.classList.add('has-val');

    document.getElementById('visitDeviceDetails').focus();
}

function quickScheduleVisit(companyName) {
    switchNocTab('visits'); populateVisitCompanies();
    const compSelect = document.getElementById('visitCompany'); compSelect.value = companyName;
    autoFillVisitDetails(); compSelect.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ==========================================
// DIRECTORY MANAGEMENT LOGIC
// ==========================================
async function fetchUsersList() {
    try {
        const resU = await apiPost({ action: 'get_users' }); const dataU = await resU.json();
        const resC = await apiPost({ action: 'db_read', target_sheet: 'Companies' }); const dataC = await resC.json();
        if (dataU.status === 'success') {
            globalUsersList = dataU.users || []; globalRegisteredCompanies = dataC.data || [];
            const compNames = globalRegisteredCompanies.map(c => c.company || c["company name"] || c.name);
            const compFilter = document.getElementById('corpUserCompanyFilter'); if (compFilter) { compFilter.innerHTML = '<option value="All">All Companies</option>' + compNames.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join(''); }
            const newUComp = document.getElementById('newUserCompany'); if (newUComp) { newUComp.innerHTML = '<option value="" disabled selected>Select Company</option>' + compNames.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join(''); }
            renderUsersList(); renderRegisteredCompanies();
        }
    } catch (e) { }
}

function renderUsersList() {
    const corpContainer = document.getElementById('corporateUsersList'); const itContainer = document.getElementById('itAdminsList');
    if (!corpContainer || !itContainer) return;
    const search = (document.getElementById('corpUserSearch')?.value || '').toLowerCase(); const companyFilter = document.getElementById('corpUserCompanyFilter')?.value || 'All';

    let itHTML = '';
    globalUsersList.forEach(u => {
        if (u.role !== 'Client' && u.role !== 'Approver') {
            let telegramBadge = u.telegram_id ? `<span class="px-2 py-0.5 ml-3 bg-blue-50 border border-blue-200 text-blue-600 rounded text-[9px] shadow-sm"><i class="fa-brands fa-telegram"></i> ${escapeHTML(u.telegram_id)}</span>` : '';
            itHTML += `<div class="flex flex-col sm:flex-row sm:items-center justify-between p-4 glass-surface bg-white rounded-xl mb-3 hover:shadow-sm transition-shadow"><div><p class="font-extrabold text-sm text-slate-800 flex items-center">${escapeHTML(u.name)} ${telegramBadge}</p><p class="text-xs font-bold text-slate-500 uppercase tracking-wider mt-1">${escapeHTML(u.email)} | ${escapeHTML(u.company)}</p></div><div class="flex items-center gap-3 mt-3 sm:mt-0"><span class="px-3 py-1 bg-blue-50 border border-blue-200 text-blue-700 rounded-full text-[10px] font-bold uppercase">${escapeHTML(u.role)}</span><button onclick="openEditITStaffModal('${escapeHTML(u.email)}', '${escapeHTML(u.role)}', '${escapeHTML(u.phone || '')}', '${escapeHTML(u.telegram_id || '')}')" class="w-8 h-8 rounded-full bg-slate-100 text-blue-600 hover:bg-slate-200 shadow-sm transition-all" title="Edit IT Staff"><i class="fa-solid fa-pen text-xs"></i></button></div></div>`;
        }
    });
    itContainer.innerHTML = itHTML || '<p class="text-sm font-bold uppercase tracking-wider text-slate-500 text-center py-4">No IT admins found.</p>';

    let hierarchyHTML = '';
    const filteredCorpUsers = globalUsersList.filter(u => (u.role === 'Client' || u.role === 'Approver') && (companyFilter === 'All' || u.company === companyFilter) && (!search || u.name.toLowerCase().includes(search) || u.email.toLowerCase().includes(search) || u.company.toLowerCase().includes(search) || (u.phone || '').includes(search)));
    const companies = [...new Set(filteredCorpUsers.map(u => u.company))];

    companies.forEach(company => {
        hierarchyHTML += `<div class="mb-8"><h4 class="font-black text-xl text-slate-800 border-b border-slate-200 pb-3 mb-4"><i class="fa-solid fa-building text-blue-600 mr-3"></i> ${escapeHTML(company)}</h4>`;
        const compUsers = filteredCorpUsers.filter(u => u.company === company); const managers = [...new Set(compUsers.map(u => u.manager || 'No Assigned Manager'))];

        managers.forEach(manager => {
            hierarchyHTML += `<div class="ml-4 mb-5"><h5 class="text-[11px] font-extrabold text-slate-500 mb-3 uppercase tracking-widest"><i class="fa-solid fa-sitemap mr-2"></i> Manager: ${escapeHTML(manager)}</h5>`;
            const reports = compUsers.filter(u => (u.manager || 'No Assigned Manager') === manager);
            reports.forEach(u => {
                const roleBadge = u.role === 'Approver' ? `<span class="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 rounded text-[9px] font-bold ml-3">APPROVER</span>` : `<span class="px-2 py-0.5 bg-slate-100 border border-slate-200 text-slate-700 rounded text-[9px] font-bold ml-3">USER</span>`;
                hierarchyHTML += `<div class="flex items-center justify-between p-4 glass-surface bg-white rounded-xl shadow-sm mb-3 ml-6 hover:shadow-md transition-shadow"><div><p class="font-extrabold text-sm text-slate-800 flex items-center">${escapeHTML(u.name)} ${roleBadge}</p><p class="text-[11px] font-bold text-slate-500 uppercase tracking-wider mt-1">${escapeHTML(u.email)} | ${escapeHTML(u.phone || 'No Phone')}</p></div><div class="flex gap-2"><button onclick="openEditCorpUserModal('${escapeHTML(u.email)}', '${escapeHTML(u.role)}', '${escapeHTML(u.manager)}', '${escapeHTML(u.company)}', '${escapeHTML(u.phone)}')" class="w-8 h-8 rounded-full bg-slate-100 text-blue-600 hover:bg-slate-200 shadow-sm transition-all"><i class="fa-solid fa-pen text-xs"></i></button><button onclick="deleteCorporateUser('${escapeHTML(u.email)}')" class="w-8 h-8 rounded-full bg-rose-50 border border-rose-200 text-rose-600 hover:bg-rose-100 flex items-center justify-center shadow-sm transition-all"><i class="fa-solid fa-trash text-xs"></i></button></div></div>`;
            });
            hierarchyHTML += `</div>`;
        });
        hierarchyHTML += `</div>`;
    });
    corpContainer.innerHTML = hierarchyHTML || '<p class="text-sm font-bold uppercase tracking-wider text-slate-500 text-center py-10">No corporate users found.</p>';
}

function renderRegisteredCompanies() {
    const container = document.getElementById('registeredCompaniesList'); if (!container) return;
    if (globalRegisteredCompanies.length === 0) { container.innerHTML = '<p class="text-sm font-bold uppercase tracking-wider text-slate-500 text-center py-10">No companies registered yet.</p>'; return; }
    let html = '';
    globalRegisteredCompanies.forEach(c => {
        const compName = c.company || c["company name"] || c.name; const safeName = compName.replace(/'/g, "\\'");
        html += `<div class="p-5 glass-surface bg-white border border-slate-200 rounded-xl mb-4 flex flex-col sm:flex-row justify-between sm:items-center hover:shadow-md transition-shadow gap-4"><div class="flex items-center gap-4"><div class="w-12 h-12 bg-blue-50 border border-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-xl shadow-sm flex-shrink-0"><i class="fa-solid fa-building"></i></div><div><h4 class="font-black text-lg text-slate-800">${escapeHTML(compName)}</h4><div class="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">${c.domain ? `<span><i class="fa-solid fa-globe mr-1 text-slate-400"></i>${escapeHTML(c.domain)}</span>` : ''}${c.phone ? `<span><i class="fa-solid fa-phone mr-1 text-slate-400"></i>${escapeHTML(c.phone)}</span>` : ''}</div></div></div>
        <div class="flex gap-2">
            <button onclick="quickScheduleVisit('${safeName}')" class="px-5 py-2 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 text-xs font-bold hover:bg-emerald-100 transition whitespace-nowrap"><i class="fa-solid fa-calendar-plus mr-2"></i>Schedule Visit</button>
            <button onclick="openEditCompanyModal('${safeName}')" class="px-5 py-2 rounded-full bg-slate-100 text-blue-600 border border-slate-200 text-xs font-bold hover:bg-slate-200 transition whitespace-nowrap"><i class="fa-solid fa-pen mr-2"></i>Edit</button>
        </div></div>`;
    });
    container.innerHTML = html;
}

async function registerNewCompany(e) {
    e.preventDefault(); const btn = e.target.querySelector('button[type="submit"]'); btn.innerHTML = "Registering..."; btn.disabled = true;
    const payload = { action: 'db_upsert', target_sheet: 'Companies', primary_key: 'company', company: document.getElementById('newRegCompanyName').value.trim(), domain: document.getElementById('newRegDomain').value.trim(), address: document.getElementById('newRegAddress').value.trim(), phone: document.getElementById('newRegPhone').value.trim(), it_contact: document.getElementById('newRegContact').value.trim(), created_date: new Date().toISOString() };
    try { await apiPost(payload); alert("Company Registered Successfully!"); e.target.reset(); fetchUsersList(); } catch (e) { alert("Network error."); }
    btn.innerHTML = "Register Company"; btn.disabled = false;
}

function openEditCompanyModal(companyName) {
    const comp = globalRegisteredCompanies.find(c => (c.company || c["company name"] || c.name) === companyName); if (!comp) return;
    document.getElementById('editCompName').value = companyName; document.getElementById('editCompDomain').value = comp.domain || ''; document.getElementById('editCompAddress').value = comp.address || ''; document.getElementById('editCompPhone').value = comp.phone || ''; document.getElementById('editCompContact').value = comp.it_contact || ''; document.getElementById('editCompNotes').value = comp.notes || '';
    ['editCompDomain', 'editCompAddress', 'editCompPhone', 'editCompContact', 'editCompNotes'].forEach(id => { const el = document.getElementById(id); if (el.value) el.classList.add('has-val'); else el.classList.remove('has-val'); });
    const modalBox = document.getElementById('editCompanyModalBox'); const modal = document.getElementById('editCompanyModal');
    modal.classList.remove('hidden'); setTimeout(() => { modal.classList.remove('opacity-0'); modalBox.classList.remove('scale-95'); }, 10);
}

function closeEditCompanyModal() {
    const modalBox = document.getElementById('editCompanyModalBox'); const modal = document.getElementById('editCompanyModal');
    modal.classList.add('opacity-0'); modalBox.classList.add('scale-95'); setTimeout(() => { modal.classList.add('hidden'); }, 200);
}

async function saveCompanyEdits(e) {
    const btn = e.target; btn.innerHTML = "Saving..."; btn.disabled = true;
    const payload = { action: 'db_upsert', target_sheet: 'Companies', primary_key: 'company', company: document.getElementById('editCompName').value, domain: document.getElementById('editCompDomain').value.trim(), address: document.getElementById('editCompAddress').value.trim(), phone: document.getElementById('editCompPhone').value.trim(), it_contact: document.getElementById('editCompContact').value.trim(), notes: document.getElementById('editCompNotes').value.trim() };
    try { await apiPost(payload); closeEditCompanyModal(); fetchUsersList(); } catch (e) { alert("Error saving company profile."); }
    btn.innerHTML = "Save Profile"; btn.disabled = false;
}

function updateManagerDropdown() {
    const selectedComp = document.getElementById('newUserCompany').value; const managerSelect = document.getElementById('newUserManager');
    const managers = globalUsersList.filter(u => u.company === selectedComp && u.role === 'Approver');
    let opts = `<option value="">No Manager / Self</option>`; managers.forEach(m => { opts += `<option value="${escapeHTML(m.name)}">${escapeHTML(m.name)} (${escapeHTML(m.email)})</option>`; });
    managerSelect.innerHTML = opts;
}

function openEditCorpUserModal(email, currentRole, currentManager, currentCompany, currentPhone) {
    document.getElementById('editCorpUserEmail').value = email; document.getElementById('editCorpUserRole').value = currentRole || 'Client'; document.getElementById('editCorpUserPhone').value = currentPhone || '';
    if (currentPhone) document.getElementById('editCorpUserPhone').classList.add('has-val'); else document.getElementById('editCorpUserPhone').classList.remove('has-val');
    const compSelect = document.getElementById('editCorpUserCompany'); let cOpts = `<option value="">Select Company</option>`;
    const compNames = globalRegisteredCompanies.map(c => c.company || c["company name"] || c.name);
    compNames.forEach(c => { cOpts += `<option value="${escapeHTML(c)}" ${c === currentCompany ? 'selected' : ''}>${escapeHTML(c)}</option>`; });
    compSelect.innerHTML = cOpts;
    populateEditManagerDropdown(currentCompany, currentManager, email);
    compSelect.onchange = (e) => { populateEditManagerDropdown(e.target.value, "", email); };
    const modalBox = document.getElementById('editCorpUserModalBox'); const modal = document.getElementById('editCorpUserModal');
    modal.classList.remove('hidden'); setTimeout(() => { modal.classList.remove('opacity-0'); modalBox.classList.remove('scale-95'); }, 10);
}

function closeEditCorpUserModal() {
    const modalBox = document.getElementById('editCorpUserModalBox'); const modal = document.getElementById('editCorpUserModal');
    modal.classList.add('opacity-0'); modalBox.classList.add('scale-95'); setTimeout(() => { modal.classList.add('hidden'); }, 200);
}

function populateEditManagerDropdown(companyName, currentManager, userEmail) {
    const managers = globalUsersList.filter(u => u.role === 'Approver' && u.email !== userEmail && u.company === companyName);
    let opts = `<option value="">No Manager Assigned</option>`; managers.forEach(m => { opts += `<option value="${escapeHTML(m.name)}">${escapeHTML(m.name)}</option>`; });
    document.getElementById('editCorpUserManager').innerHTML = opts;
}

async function saveCorpUserEdits(e) {
    const email = document.getElementById('editCorpUserEmail').value; const role = document.getElementById('editCorpUserRole').value; const manager = document.getElementById('editCorpUserManager').value; const company = document.getElementById('editCorpUserCompany').value; const phone = document.getElementById('editCorpUserPhone').value;
    const btn = e.target; btn.innerHTML = "Saving..."; btn.disabled = true;
    try { await apiPost({ action: 'update_user_profile', email: email, role: role, manager: manager, company: company, phone: phone }); closeEditCorpUserModal(); fetchUsersList(); } catch (e) { alert("Error saving user."); }
    btn.innerHTML = "Save Changes"; btn.disabled = false;
}

function openEditITStaffModal(email, currentRole, currentPhone, currentTelegram) {
    document.getElementById('editITStaffEmail').value = email; document.getElementById('editITStaffRole').value = currentRole || 'Tier 1 Support'; document.getElementById('editITStaffPhone').value = currentPhone || ''; document.getElementById('editITStaffTelegram').value = currentTelegram || '';
    if (currentPhone) document.getElementById('editITStaffPhone').classList.add('has-val'); else document.getElementById('editITStaffPhone').classList.remove('has-val');
    if (currentTelegram) document.getElementById('editITStaffTelegram').classList.add('has-val'); else document.getElementById('editITStaffTelegram').classList.remove('has-val');
    const modalBox = document.getElementById('editITStaffModalBox'); const modal = document.getElementById('editITStaffModal');
    modal.classList.remove('hidden'); setTimeout(() => { modal.classList.remove('opacity-0'); modalBox.classList.remove('scale-95'); }, 10);
}

function closeEditITStaffModal() {
    const modalBox = document.getElementById('editITStaffModalBox'); const modal = document.getElementById('editITStaffModal');
    modal.classList.add('opacity-0'); modalBox.classList.add('scale-95'); setTimeout(() => { modal.classList.add('hidden'); }, 200);
}

async function saveITStaffEdits(e) {
    const email = document.getElementById('editITStaffEmail').value; const role = document.getElementById('editITStaffRole').value; const phone = document.getElementById('editITStaffPhone').value; const telegram_id = document.getElementById('editITStaffTelegram').value;
    const btn = e.target; btn.innerHTML = "Updating..."; btn.disabled = true;
    try { await apiPost({ action: 'update_user_profile', email: email, role: role, phone: phone, telegram_id: telegram_id }); closeEditITStaffModal(); fetchUsersList(); } catch (e) { alert("Error saving IT staff profile."); }
    btn.innerHTML = "Update Staff"; btn.disabled = false;
}

function exportUsersExcel() {
    if (globalUsersList.length === 0) return alert("No users to export.");
    const corpUsers = globalUsersList.filter(u => u.role === 'Client' || u.role === 'Approver').map(u => ({ Name: u.name, Email: u.email, Phone: u.phone, Company: u.company, Role: u.role, Manager: u.manager }));
    if (corpUsers.length === 0) return alert("No corporate users found.");
    const ws = XLSX.utils.json_to_sheet(corpUsers); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Corporate Users"); XLSX.writeFile(wb, "Spread_Corporate_Users.xlsx");
}

async function createCorporateUser(e) {
    e.preventDefault(); const btn = e.target.querySelector('button[type="submit"]'); btn.innerHTML = "Creating..."; btn.disabled = true;
    const email = document.getElementById('newUserEmail').value.trim().toLowerCase(); const name = document.getElementById('newUserName').value.trim();
    const payload = { action: 'register_client', email: email, company: document.getElementById('newUserCompany').value.trim(), name: name, phone: document.getElementById('newUserPhone').value.trim(), role: document.getElementById('newUserRole').value, manager: document.getElementById('newUserManager').value.trim() };
    try { await apiPost(payload); alert("User creation request sent.\n\nAn automated welcome email containing the password will be sent to " + email); e.target.reset(); fetchUsersList(); } catch (e) { alert("Network error."); }
    btn.innerHTML = "Generate User"; btn.disabled = false;
}

async function registerNewAdmin(e) {
    e.preventDefault(); const btn = e.target.querySelector('button[type="submit"]'); btn.innerHTML = "Provisioning..."; btn.disabled = true;
    const email = document.getElementById('newAdminEmail').value.trim().toLowerCase(); const name = document.getElementById('newAdminName').value.trim();
    const payload = { action: 'register_it_staff', email: email, company: "Spread Technical - IT Support", name: name, role: document.getElementById('newAdminRole').value, telegram_id: document.getElementById('newAdminTelegram').value.trim() };
    try { await apiPost(payload); alert("Admin account provisioned. Credentials emailed to staff."); e.target.reset(); fetchUsersList(); } catch (e) { alert("Network error."); }
    btn.innerHTML = "Provision Account"; btn.disabled = false;
}

async function deleteCorporateUser(email) {
    if (!confirm(`Delete user ${email}?`)) return;
    try { await apiPost({ action: 'delete_user', email: email }); fetchUsersList(); } catch (e) { alert("Failed to delete user."); }
}

// ==========================================
// TICKET SUBMISSION LOGIC
// ==========================================
function handleRequestTypeChange() {
    const reqSelect = document.getElementById('requestType');
    const reqType = reqSelect ? reqSelect.value : 'Incident';
    const catSelect = document.getElementById('deviceType');

    if (!catSelect) return;

    const filteredCategories = appConfigData.filter(c => c.type === 'Category' && c.parent === reqType);

    if (filteredCategories.length > 0) {
        let html = `<option value="" disabled selected>Select Category</option>`;
        filteredCategories.forEach(c => { html += `<option value="${c.value}">${c.value}</option>`; });
        catSelect.innerHTML = html;
    } else {
        if (reqType === 'Incident') { catSelect.innerHTML = `<option value="" disabled selected>Select Incident Category</option><option value="Authentication/Login">Account & Access</option><option value="Laptop/Desktop">Endpoint Hardware</option><option value="Software/App">Software & Applications</option>`; }
        else { catSelect.innerHTML = `<option value="" disabled selected>Select Service Category</option><option value="New Asset Setup">New Employee Setup</option><option value="New Device Peripherals">Hardware Request</option>`; }
    }

    updateFormLogic();
}

function updateFormLogic() {
    const reqType = document.getElementById('requestType') ? document.getElementById('requestType').value : 'Incident';
    const category = document.getElementById('deviceType') ? document.getElementById('deviceType').value : '';
    const priority = document.getElementById('priority') ? document.getElementById('priority').value : 'Medium';

    const priorityWrapper = document.getElementById('priorityWrapper');
    const assetTagWrapper = document.getElementById('assetTagWrapper');
    if (reqType === 'Service') {
        if (priorityWrapper) priorityWrapper.style.display = 'none';
        if (assetTagWrapper) assetTagWrapper.style.display = 'none';
    } else {
        if (priorityWrapper) priorityWrapper.style.display = 'flex';
        if (assetTagWrapper) assetTagWrapper.style.display = 'flex';
    }

    const joineeFields = document.getElementById('newJoineeFields'); const jName = document.getElementById('joineeName'); const jLoc = document.getElementById('joineeLocation');
    if (category === 'New Asset Setup' && joineeFields) { joineeFields.classList.remove('hidden'); jName.disabled = false; jLoc.disabled = false; } else if (joineeFields) { joineeFields.classList.add('hidden'); jName.disabled = true; jLoc.disabled = true; jName.value = ''; jLoc.value = ''; }
    const peripheralFields = document.getElementById('newPeripheralFields'); const pList = document.getElementById('peripheralList');
    if (category === 'New Device Peripherals' && peripheralFields) { peripheralFields.classList.remove('hidden'); pList.disabled = false; } else if (peripheralFields) { peripheralFields.classList.add('hidden'); pList.disabled = true; pList.value = ''; }

    const rsFields = document.getElementById('remoteSupportFields'); const rsId = document.getElementById('remoteId'); const rsPass = document.getElementById('remotePass'); const rApp = document.getElementById('remoteApp');
    if (reqType === 'Incident' && (category === 'Laptop/Desktop' || category === 'Software/App') && (priority === 'Low' || priority === 'Medium') && rsFields) {
        rsFields.classList.remove('hidden'); rsId.disabled = false; rsPass.disabled = false; rApp.disabled = false;
    } else if (rsFields) {
        rsFields.classList.add('hidden'); rsId.disabled = true; rsPass.disabled = true; rApp.disabled = true; rsId.value = ''; rsPass.value = '';
    }
}

function handleTicketForChange() {
    const isElse = document.getElementById('ticketFor').value === 'Someone Else'; const peerWrapper = document.getElementById('peerWrapper'); const peerSelect = document.getElementById('ticketForPeer'); const tName = document.getElementById('ticketName'); const tEmail = document.getElementById('ticketEmail'); const tPhone = document.getElementById('phoneNumber'); const pLabel = document.getElementById('phoneLabel');
    if (isElse) {
        peerWrapper.classList.remove('hidden'); tPhone.required = true; pLabel.innerText = "Contact Number *";
        let opts = `<option value="" disabled selected></option>`;
        if (clientSession && clientSession.peers) { clientSession.peers.forEach(p => { if (p.email.toLowerCase() !== clientSession.email.toLowerCase()) { opts += `<option value="${p.email}" data-name="${escapeHTML(p.name)}" data-phone="${escapeHTML(p.phone || '')}">${escapeHTML(p.name)} (${p.email})</option>`; } }); }
        peerSelect.innerHTML = opts; peerSelect.disabled = false;
        peerSelect.onchange = () => { const opt = peerSelect.options[peerSelect.selectedIndex]; tName.value = opt.getAttribute('data-name'); tEmail.value = opt.value; tPhone.value = opt.getAttribute('data-phone') || ''; tName.classList.add('has-val'); tEmail.classList.add('has-val'); if (tPhone.value) tPhone.classList.add('has-val'); else tPhone.classList.remove('has-val'); };
        tName.value = ""; tEmail.value = ""; tPhone.value = ""; tName.classList.remove('has-val'); tEmail.classList.remove('has-val'); tPhone.classList.remove('has-val');
    } else {
        peerWrapper.classList.add('hidden'); peerSelect.disabled = true; tPhone.required = false; pLabel.innerText = "Contact Number";
        tName.value = clientSession.name; tEmail.value = clientSession.email; tPhone.value = clientSession.phone || "";
        tName.classList.add('has-val'); tEmail.classList.add('has-val'); if (tPhone.value) tPhone.classList.add('has-val'); else tPhone.classList.remove('has-val');
    }
}

function handleRemoteAppChange() { const app = document.getElementById('remoteApp').value; const passLabel = document.getElementById('remotePassLabel'); if (app === 'AnyDesk') { passLabel.innerText = "Remote Password (Optional)"; } else { passLabel.innerText = "Remote Password"; } }

function toggleNewTicketForm() {
    const form = document.getElementById('newTicketFormContainer'); form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) { handleRequestTypeChange(); if (clientSession) { document.getElementById('ticketCompany').value = clientSession.company; document.getElementById('ticketCompany').classList.add('has-val'); handleTicketForChange(); } }
}

async function submitTicket(e) {
    e.preventDefault(); const btn = document.getElementById('submitBtn'); const rsFields = document.getElementById('remoteSupportFields'); const fileInput = document.getElementById('attachmentFile'); let rsAppVal = '', rsIdVal = '', rsPassVal = '';
    if (!rsFields.classList.contains('hidden')) {
        rsAppVal = document.getElementById('remoteApp').value; rsIdVal = document.getElementById('remoteId').value.trim(); rsPassVal = document.getElementById('remotePass').value.trim(); const requiresPass = (rsAppVal !== 'AnyDesk');
        if (!rsIdVal && (!rsPassVal && requiresPass) && (!fileInput || fileInput.files.length === 0)) { alert("ACTION REQUIRED:\n\nFor Low/Medium priority Endpoint Incidents, you MUST either provide your Remote Support credentials OR attach a screenshot of the issue."); return; }
    }
    btn.innerHTML = 'Processing...'; btn.disabled = true;
    const reqType = document.getElementById('requestType').value; const category = document.getElementById('deviceType').value; let desc = document.getElementById('message').value; const contactMethod = document.getElementById('contactMethod').value; const ccEmail = document.getElementById('ticketCC').value.trim();
    desc = `[Contact via: ${contactMethod}]\n` + (ccEmail ? `[CC: ${ccEmail}]\n\n` : '\n') + desc;
    let status = (reqType === "Service") ? "Pending Approval" : "Monitoring"; let remoteSupportStr = "N/A";
    if (!rsFields.classList.contains('hidden') && (rsIdVal || rsPassVal)) { remoteSupportStr = `App: ${rsAppVal} | ID: ${rsIdVal || 'N/A'} | Pass: ${rsPassVal || 'Optional'}`; }
    if (category === 'New Asset Setup') { const jName = document.getElementById('joineeName').value; const jLoc = document.getElementById('joineeLocation').value; desc = `[NEW JOINEE SETUP]\nJoinee Name: ${jName}\nLocation/Desk: ${jLoc}\n\nAdditional Notes:\n${desc}`; } else if (category === 'New Device Peripherals') { const selectedPeripheral = document.getElementById('peripheralList').value; desc = `[NEW PERIPHERAL REQUEST]\nRequested Item: ${selectedPeripheral}\n\nAdditional Notes:\n${desc}`; }
    const phoneNumber = document.getElementById('phoneNumber').value.trim(); const fullPhone = phoneNumber ? `(${document.getElementById('countryCode').value}) ${phoneNumber}` : "N/A";
    let fileData = null, fileName = null, fileMimeType = null;
    if (fileInput && fileInput.files.length > 0) {
        const file = fileInput.files[0]; if (file.size > 5 * 1024 * 1024) { alert("File too large. Max 5MB allowed."); btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Submit Ticket'; btn.disabled = false; return; }
        fileName = file.name; fileMimeType = file.type; fileData = await new Promise((resolve) => { const reader = new FileReader(); reader.onloadend = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(file); });
    }
    const payload = { action: "create_ticket", id: "", name: document.getElementById('ticketName').value.trim(), company: document.getElementById('ticketCompany').value.trim(), phone: fullPhone, email: document.getElementById('ticketEmail').value.trim(), request_type: reqType, category: category, impact_level: reqType === 'Service' ? 'Low' : document.getElementById('priority').value, asset: document.getElementById('assetTag').value || "N/A", device: category, remote_support: remoteSupportStr, priority: reqType === 'Service' ? 'Low' : document.getElementById('priority').value, subject: document.getElementById('ticketSubject').value, description: desc, date: new Date().toISOString(), status: status, fileData: fileData, fileName: fileName, fileMimeType: fileMimeType };
    try { const res = await apiPost(payload); const data = await res.json(); alert(`Ticket ${data.id} Submitted!\nStatus: ${status}`); document.getElementById('ticketForm').reset(); toggleNewTicketForm(); fetchClientTickets(); if (clientSession && clientSession.role === 'Approver') fetchApproverTickets(); } catch (e) { alert('Error submitting ticket. Try without attachment if it persists.'); }
    btn.innerHTML = '<i class="fa-solid fa-paper-plane mr-2"></i> Submit Ticket'; btn.disabled = false;
}

// ==========================================
// KNOWLEDGE BASE ENGINE
// ==========================================
function toggleKB(btn) {
    const item = btn.parentElement;
    document.querySelectorAll('.kb-item').forEach(el => { if (el !== item) { const content = el.querySelector('.kb-item-content'); if (content) content.classList.add('hidden'); const icon = el.querySelector('i.kb-icon'); if (icon) icon.classList.remove('rotate-180'); } });
    const content = item.querySelector('.kb-item-content'); const icon = item.querySelector('i.kb-icon');
    if (content.classList.contains('hidden')) { content.classList.remove('hidden'); icon.classList.add('rotate-180'); } else { content.classList.add('hidden'); icon.classList.remove('rotate-180'); }
}
function filterKB(e) {
    const input = document.getElementById('kbSearchInput').value.toLowerCase(); const items = document.querySelectorAll('.kb-item'); let found = false;
    items.forEach(item => { if (item.innerText.toLowerCase().includes(input)) { item.style.display = "block"; found = true; } else { item.style.display = "none"; const content = item.querySelector('.kb-item-content'); if (content) content.classList.add('hidden'); } });
    document.getElementById('kbNoResults').style.display = (!found && input.trim() !== '') ? 'block' : 'none';
    if (e && e.key === 'Enter' && input.trim() !== '') searchGoogle();
}
function searchGoogle() {
    const query = document.getElementById('kbSearchInput').value.trim();
    if (query) window.open('https://www.google.com/search?q=' + encodeURIComponent(query + " troubleshooting IT support"), '_blank');
}

// ==========================================
// ANALYTICS & EXPORT ENGINE
// ==========================================
function updateChart(tickets) {
    const ctx = document.getElementById('monthlyChart'); if (!ctx) return;
    const monthlyCounts = {};
    tickets.forEach(t => { try { const d = new Date(t.date); const monthYear = d.toLocaleString('default', { month: 'short', year: 'numeric' }); if (monthYear !== "Invalid Date") { monthlyCounts[monthYear] = (monthlyCounts[monthYear] || 0) + 1; } } catch (e) { } });
    const labels = Object.keys(monthlyCounts).sort((a, b) => new Date(a) - new Date(b)); const data = labels.map(l => monthlyCounts[l]);
    chartDataExport = labels.map((l, i) => ({ Month: l, Total_Tickets: data[i] }));
    if (monthlyChartInstance) monthlyChartInstance.destroy();
    monthlyChartInstance = new Chart(ctx.getContext('2d'), {
        type: 'line', data: { labels: labels, datasets: [{ label: 'Service Requests', data: data, borderColor: '#2563eb', backgroundColor: 'rgba(37, 99, 235, 0.08)', borderWidth: 3, fill: true, tension: 0.3, pointBackgroundColor: '#2563eb', pointRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0, color: '#64748b' }, grid: { color: 'rgba(0,0,0,0.04)' } }, x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(0,0,0,0.04)' } } } }
    });
}

function renderCompanyGrid() {
    const grid = document.getElementById('companyCardsGrid'); if (!grid) return;
    const comps = [...new Set(nocDashboardTickets.map(t => t.company).filter(Boolean))]; let html = '';
    comps.forEach(c => {
        let tCount = nocDashboardTickets.filter(t => t.company === c).length;
        html += `<div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between"><div class="flex items-center gap-4"><div class="w-10 h-10 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold border border-blue-100"><i class="fa-solid fa-building"></i></div><div><h4 class="font-black text-slate-800 text-sm">${escapeHTML(c)}</h4><p class="text-xs text-slate-500 font-medium">Active Infrastructure</p></div></div><h3 class="text-2xl font-black text-blue-600">${tCount}</h3></div>`;
    });
    grid.innerHTML = html || '<p class="text-slate-500 text-sm">No ticket data available.</p>';
}

function exportGlobalQueueExcel() {
    if (nocDashboardTickets.length === 0) return alert("No data to export.");
    const cleanData = nocDashboardTickets.map(t => ({ "Ticket ID": t.id, "Date": t.date, "Company": t.company, "Requester": t.name, "Email": t.email, "Phone": t.phone, "Type": t.request_type, "Category": t.category, "Priority": t.priority, "Asset/Host": t.asset, "Subject": t.subject, "Status": t.status, "Assigned To": t.assigned_to, "Remote ID": t.remote_support }));
    const ws = XLSX.utils.json_to_sheet(cleanData); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Global Queue"); XLSX.writeFile(wb, "SpreadIT_GlobalQueue.xlsx");
}

function exportFullRawTickets() {
    if (nocDashboardTickets.length === 0) return alert("No data to export.");
    const cleanData = nocDashboardTickets.map(t => { let d = { ...t }; delete d.chat_history; delete d.fileData; return d; });
    const ws = XLSX.utils.json_to_sheet(cleanData); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Raw Tickets Data"); XLSX.writeFile(wb, "SpreadIT_Raw_Tickets_Data.xlsx");
}

function exportChartExcel() {
    if (chartDataExport.length === 0) return alert("No chart data to export.");
    const ws = XLSX.utils.json_to_sheet(chartDataExport); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Monthly Analytics"); XLSX.writeFile(wb, "SpreadIT_Monthly_Analytics.xlsx");
}

function exportChartPPT() {
    if (chartDataExport.length === 0) return alert("No chart data to export.");
    let pptx = new PptxGenJS(); let slide = pptx.addSlide(); slide.addText("Monthly Ticketing Analytics", { x: 0.5, y: 0.5, fontSize: 24, color: '363636', bold: true });
    let tableData = [["Month", "Total Tickets"]]; chartDataExport.forEach(r => tableData.push([r.Month, r.Total_Tickets]));
    slide.addTable(tableData, { x: 0.5, y: 1.5, w: 8, fill: 'F1F1F1', fontSize: 14, color: '363636' }); pptx.writeFile({ fileName: "SpreadIT_Analytics.pptx" });
}

function exportChartPDF() {
    if (chartDataExport.length === 0) return alert("No chart data to export.");
    const { jsPDF } = window.jspdf; const doc = new jsPDF(); doc.setFontSize(20); doc.text("Monthly Ticketing Analytics", 14, 22); doc.setFontSize(12);
    let startY = 40; doc.text("Month", 14, startY); doc.text("Total Tickets", 80, startY); startY += 10;
    chartDataExport.forEach(r => { doc.text(String(r.Month), 14, startY); doc.text(String(r.Total_Tickets), 80, startY); startY += 10; });
    doc.save("SpreadIT_Analytics.pdf");
}
