// CONFIGURACIÓN SUPABASE REAL DE RO
const SUPABASE_URL = 'https://bcsmkbtvmabmcuzeehad.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n6gpg6LRXdKHERrCGMjllw_bKM9vECK';

let client = null;
let inventory = { turbos: [], lubricentro: [] };
let sales = [];
let receptions = [];
let expenses = [];
let currentUser = null;
const DEBIT_PERCENT = 1.06;
const CREDIT_PERCENT = 1.096;
let wegaData = [];
let mannData = [];
let currentSelection = { oil: null, air: null, fuel: null, cabin: null };

function parseMoney(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    let clean = val.toString().replace(/\$/g, '').replace(/\s/g, '');
    if (clean.includes(',') && clean.includes('.')) {
        // Point is thousands, comma is decimal (e.g. 67.387,43)
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (clean.includes(',')) {
        // Comma is decimal
        clean = clean.replace(',', '.');
    }
    return parseFloat(clean) || 0;
}

const DEFAULT_VEHICLES = {
    "fiorino_14": { name: "Fiat Fiorino 1.4 Fire Evo", oil_type: "5W30", oil_liters: 2.9, filters: ["WEO-0003", "FAP-9054", "FCI-1660", "AKX-1445"] },
    "hilux_24": { name: "Toyota Hilux 2.4/2.8 (2016+)", oil_type: "5W30", oil_liters: 7.5, filters: ["WEO-0014", "JFA-0213", "FCD-2173", "AKX-1965"] }
};

let VEHICLE_DB = { ...DEFAULT_VEHICLES };
let editingIndex = null;
async function init() {
    // 1. Inicializar Supabase inmediatamente para evitar que sea null
    try {
        if (typeof supabase !== 'undefined') {
            client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        }
    } catch (e) { console.warn("Supabase init error:", e); }

    // 2. Configurar componentes básicos
    setupTabs();
    setupAuth();
    setupSearch();
    setupModal();
    setupPOS();
    setupImport();
    setupBudget();
    setupWegaManualImport();
    setupMannManualImport();
    setupServiceModal();
    setupReception();
    setupExpense();
    setupWhatsApp();
    setupVehiclesExcelImport();
    setupBudgetSuggestions();
    
    // 3. Cargar archivos y almacenamiento local de forma segura
    try { loadWegaExcel(); } catch (e) { console.warn(e); }
    try { loadMannExcel(); } catch (e) { console.warn(e); }
    try { loadFromLocal(); } catch (e) { console.warn(e); }
    
    // 4. Renderizar pantalla inicial
    try { renderAll(); } catch (e) { console.warn(e); }

    // 5. Revisar si hay una sesión activa de Supabase
    if (client) {
        try {
            const { data } = await client.auth.getSession();
            if (data?.session) {
                currentUser = data.session.user;
                document.getElementById('login-screen').classList.add('hidden');
                await loadFromCloud();
                await loadCustomVehicles();
            }
        } catch (e) { console.warn("Session check error:", e); }
    }
}

function setupAuth() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        
        // Evitar error de "properties of null (reading 'auth')" si el CDN falló o fue bloqueado
        if (!client) {
            alert("⚠️ No se pudo establecer conexión con el servidor de base de datos.\n\nPor favor:\n1. Asegúrate de estar conectado a internet.\n2. Desactiva bloqueadores de publicidad muy estrictos (como el escudo de Brave Browser o uBlock Origin).\n3. Recarga la página y vuelve a intentar.");
            return;
        }
        
        try {
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (error) alert("Error: " + error.message);
            else { 
                currentUser = data.user; 
                document.getElementById('login-screen').classList.add('hidden'); 
                await loadFromCloud(); 
                await loadCustomVehicles(); 
            }
        } catch (err) { alert("Error: " + err.message); }
    };
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.onclick = async () => { if (client) await client.auth.signOut(); location.reload(); };
    }
}

async function fetchAllFromCloud(tableName) {
    let allData = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    
    while (hasMore) {
        const { data, error } = await client
            .from(tableName)
            .select('*')
            .range(page * pageSize, (page + 1) * pageSize - 1);
            
        if (error) {
            console.error(`Error al cargar datos de ${tableName} en la página ${page}:`, error);
            throw error;
        }
        
        if (data && data.length > 0) {
            allData = allData.concat(data);
            if (data.length < pageSize) {
                hasMore = false;
            } else {
                page++;
            }
        } else {
            hasMore = false;
        }
    }
    return allData;
}

async function loadFromCloud() {
    if (!client) return;
    try {
        const inv = await fetchAllFromCloud('datos_taller_ro');
        const sls = await fetchAllFromCloud('ventas_taller_ro');
        if (inv) {
            inventory.turbos = inv.filter(i => i.category === 'turbos');
            inventory.lubricentro = inv.filter(i => i.category === 'lubricentro');
            
            // Cargar recepciones de turbos
            receptions = inv
                .filter(i => i.category === 'reception_turbo')
                .map(row => {
                    try {
                        return JSON.parse(row.vehicle);
                    } catch (err) {
                        console.error("Error parsing reception turbo:", err, row.vehicle);
                        return null;
                    }
                })
                .filter(r => r !== null);
            
            // Cargar gastos
            expenses = inv
                .filter(i => i.category === 'expense')
                .map(row => {
                    try {
                        return JSON.parse(row.vehicle);
                    } catch (err) {
                        console.error("Error parsing expense:", err, row.vehicle);
                        return null;
                    }
                })
                .filter(e => e !== null);
            
            // Limpiar duplicados de ventas automáticamente en la vista local
            const uniqueSales = [];
            const seenSales = new Set();
            (sls || []).forEach(s => {
                const key = `${s.name}_${s.price}_${s.date}`;
                if (!seenSales.has(key)) {
                    seenSales.add(key);
                    uniqueSales.push(s);
                }
            });
            sales = uniqueSales;
            
            renderAll();
        }
    } catch (e) { console.error("Error cargando datos de Supabase:", e); }
}

async function syncWithCloud(manual = false) {
    if (!client || !currentUser) return;
    try {
        const all = [...inventory.turbos.map(i=>({...i, category:'turbos'})), ...inventory.lubricentro.map(i=>({...i, category:'lubricentro'}))];
        await client.from('datos_taller_ro').delete().in('category', ['turbos', 'lubricentro']);
        if (all.length > 0) {
            for (let i = 0; i < all.length; i += 500) await client.from('datos_taller_ro').insert(all.slice(i, i + 500));
        }
        // Ya no sincronizamos todas las ventas aquí para evitar duplicados. Se insertan individualmente en completeSale.
        if (manual) alert("✅ Nube sincronizada");
    } catch (e) { console.error(e); }
}

async function saveData() {
    localStorage.setItem('taller_inventory', JSON.stringify(inventory));
    localStorage.setItem('taller_sales', JSON.stringify(sales));
    localStorage.setItem('taller_receptions', JSON.stringify(receptions));
    localStorage.setItem('taller_expenses', JSON.stringify(expenses));
    await syncWithCloud();
}

function loadFromLocal() {
    try {
        const inv = localStorage.getItem('taller_inventory');
        const sls = localStorage.getItem('taller_sales');
        const recs = localStorage.getItem('taller_receptions');
        const exps = localStorage.getItem('taller_expenses');
        if (inv) inventory = JSON.parse(inv);
        if (sls) sales = JSON.parse(sls);
        if (recs) receptions = JSON.parse(recs);
        if (exps) expenses = JSON.parse(exps);
    } catch (e) {
        console.warn("Local storage parse error:", e);
    }
}

function renderAll() { renderTurbos(); renderLubricentro(); renderSales(); renderReceptions(); renderExpenses(); updateOilSelect(); renderDashboard(); }

function renderTurbos(filter = '') {
    const tbody = document.querySelector('#table-turbos tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    
    // Sort alphabetically by type, and then by name
    inventory.turbos.sort((a, b) => {
        const typeA = (a.type || '').trim().toLowerCase();
        const typeB = (b.type || '').trim().toLowerCase();
        if (typeA !== typeB) {
            return typeA.localeCompare(typeB, 'es', { sensitivity: 'base' });
        }
        const nameA = (a.name || '').trim().toLowerCase();
        const nameB = (b.name || '').trim().toLowerCase();
        return nameA.localeCompare(nameB, 'es', { sensitivity: 'base' });
    });

    inventory.turbos.forEach((item, index) => {
        if (filter) {
            const q = filter.toLowerCase();
            const matchName = item.name?.toLowerCase().includes(q);
            const matchId = item.id?.toLowerCase().includes(q);
            const matchVehicle = item.vehicle?.toLowerCase().includes(q);
            const matchType = item.type?.toLowerCase().includes(q);
            if (!matchName && !matchId && !matchVehicle && !matchType) return;
        }
        const tr = document.createElement('tr');
        const safePrice = parseFloat(item.price) || 0;
        tr.innerHTML = `<td>${item.type || '-'}</td><td><strong>${item.id}</strong></td><td>${item.name}</td><td>${item.vehicle || '-'}</td><td>$${safePrice.toFixed(2)}</td><td class="${item.stock <= 2 ? 'stock-low' : ''}">${item.stock}</td><td><button onclick="changeStock('turbos', ${index}, -1)">-</button><button onclick="changeStock('turbos', ${index}, 1)">+</button><button style="background:#3b82f6; color:white; border-radius:4px; border:none; padding:2px 5px; margin-left:5px;" onclick="openEditModal('turbos', ${index})">✏️</button></td>`;
        tbody.appendChild(tr);
    });
}

function renderLubricentro(filter = '') {
    const tbody = document.querySelector('#table-lubricentro tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    
    // Sort alphabetically by type, and then by name
    inventory.lubricentro.sort((a, b) => {
        const typeA = (a.type || '').trim().toLowerCase();
        const typeB = (b.type || '').trim().toLowerCase();
        if (typeA !== typeB) {
            return typeA.localeCompare(typeB, 'es', { sensitivity: 'base' });
        }
        const nameA = (a.name || '').trim().toLowerCase();
        const nameB = (b.name || '').trim().toLowerCase();
        return nameA.localeCompare(nameB, 'es', { sensitivity: 'base' });
    });

    inventory.lubricentro.forEach((item, index) => {
        if (filter) {
            const q = filter.toLowerCase();
            const matchName = item.name?.toLowerCase().includes(q);
            const matchId = item.id?.toLowerCase().includes(q);
            const matchType = item.type?.toLowerCase().includes(q);
            if (!matchName && !matchId && !matchType) return;
        }
        const tr = document.createElement('tr');
        const safePrice = parseFloat(item.price) || 0;
        tr.innerHTML = `<td>${item.type || '-'}</td><td><strong>${item.id}</strong></td><td>${item.name}</td><td>$${safePrice.toFixed(2)}</td><td class="${item.stock <= 5 ? 'stock-low' : ''}">${item.stock}</td><td><button onclick="changeStock('lubricentro', ${index}, -1)">-</button><button onclick="changeStock('lubricentro', ${index}, 1)">+</button><button style="background:#3b82f6; color:white; border-radius:4px; border:none; padding:2px 5px; margin-left:5px;" onclick="openEditModal('lubricentro', ${index})">✏️</button></td>`;
        tbody.appendChild(tr);
    });
}

function guessPaymentMethod(sale) {
    if (sale.item_id === 'SERVICE') return 'Efectivo';
    const item = inventory[sale.category]?.find(i => i.id === sale.item_id);
    if (!item || !item.price) return '-';
    
    let qty = 1;
    const match = sale.name.match(/\(x(\d+)\)/);
    if (match) {
        qty = parseInt(match[1], 10);
    }
    
    const baseTotalCurrent = item.price * qty;
    if (baseTotalCurrent <= 0) return '-';
    
    // 1. Probar con el precio actual (para ventas recientes o productos excluidos del aumento)
    const ratioCurrent = sale.price / baseTotalCurrent;
    if (Math.abs(ratioCurrent - 1.0) < 0.02) return 'Efectivo';
    if (Math.abs(ratioCurrent - DEBIT_PERCENT) < 0.02) return 'Débito';
    if (Math.abs(ratioCurrent - CREDIT_PERCENT) < 0.02) return 'Crédito';
    
    // 2. Probar con el precio anterior (dividiendo por 1.21 para productos que sufrieron el aumento)
    const nameUpper = item.name.toUpperCase();
    const isDexron = nameUpper.includes("VALVOLINE DEXRON3 ATF HIDRAULICO") || nameUpper.includes("DEXRON3");
    const is5w30c3 = nameUpper.includes("VALVOLINE 5W30 ACEA C3") || (nameUpper.includes("5W30") && nameUpper.includes("C3"));
    
    if (!isDexron && !is5w30c3) {
        const baseTotalOld = (item.price / 1.21) * qty;
        const ratioOld = sale.price / baseTotalOld;
        if (Math.abs(ratioOld - 1.0) < 0.02) return 'Efectivo';
        if (Math.abs(ratioOld - DEBIT_PERCENT) < 0.02) return 'Débito';
        if (Math.abs(ratioOld - CREDIT_PERCENT) < 0.02) return 'Crédito';
    }
    
    return 'Efectivo';
}

function renderSales() {
    const tT = document.querySelector('#table-ventas-turbos tbody');
    const tL = document.querySelector('#table-ventas-lubricentro tbody');
    if (!tT || !tL) return;
    tT.innerHTML = ''; tL.innerHTML = '';
    let totT = 0, totL = 0;
    let lubCash = 0, lubTransfer = 0, lubDebit = 0, lubCredit = 0;
    
    sales.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(s => {
        const tr = document.createElement('tr');
        const d = new Date(s.date).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' });
        const safePrice = parseFloat(s.price) || 0;
        
        let paymentMethod = '-';
        let displayName = s.name;
        
        const methodMatch = s.name.match(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/);
        if (methodMatch) {
            paymentMethod = methodMatch[1];
            displayName = s.name.replace(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/, '');
        } else {
            paymentMethod = guessPaymentMethod(s);
        }
        
        let badgeClass = 'badge-other';
        if (paymentMethod === 'Efectivo') badgeClass = 'badge-cash';
        else if (paymentMethod === 'Transferencia') badgeClass = 'badge-transfer';
        else if (paymentMethod === 'Débito') badgeClass = 'badge-debit';
        else if (paymentMethod === 'Crédito') badgeClass = 'badge-credit';
        
        const paymentBadge = `<span class="payment-badge ${badgeClass}">${paymentMethod}</span>`;
        
        if (s.category === 'turbos') {
            const item = inventory.turbos.find(t => t.id === s.item_id);
            const type = item ? (item.type || '-') : '-';
            const code = s.item_id || '-';
            
            tr.innerHTML = `
                <td>${d}</td>
                <td>${type}</td>
                <td><strong>${code}</strong></td>
                <td>${displayName}</td>
                <td>${paymentBadge}</td>
                <td>$${safePrice.toFixed(2)}</td>
                <td><button style="color:red; border:none; background:none; cursor:pointer;" onclick="deleteSale('${s.id}', '${s.date}')">Anular</button></td>
            `;
            totT += safePrice; 
            tT.appendChild(tr); 
        } else { 
            tr.innerHTML = `<td>${d}</td><td><strong>${displayName}</strong></td><td>${paymentBadge}</td><td>$${safePrice.toFixed(2)}</td><td><button style="color:red; border:none; background:none; cursor:pointer;" onclick="deleteSale('${s.id}', '${s.date}')">Anular</button></td>`;
            totL += safePrice; 
            if (paymentMethod === 'Efectivo') lubCash += safePrice;
            else if (paymentMethod === 'Transferencia') lubTransfer += safePrice;
            else if (paymentMethod === 'Débito') lubDebit += safePrice;
            else if (paymentMethod === 'Crédito') lubCredit += safePrice;
            tL.appendChild(tr); 
        }
    });
    document.getElementById('total-sales-turbos').innerText = `$${totT.toFixed(2)}`;
    document.getElementById('total-sales-lubricentro').innerText = `$${totL.toFixed(2)}`;
    
    const elCash = document.getElementById('total-lub-cash');
    const elTransfer = document.getElementById('total-lub-transfer');
    const elDebit = document.getElementById('total-lub-debit');
    const elCredit = document.getElementById('total-lub-credit');
    if (elCash) elCash.innerText = `$${lubCash.toFixed(2)}`;
    if (elTransfer) elTransfer.innerText = `$${lubTransfer.toFixed(2)}`;
    if (elDebit) elDebit.innerText = `$${lubDebit.toFixed(2)}`;
    if (elCredit) elCredit.innerText = `$${lubCredit.toFixed(2)}`;
}

function openEditModal(cat, index) {
    const item = inventory[cat][index]; editingIndex = index;
    document.getElementById('modal-category').value = cat;
    document.getElementById('modal-title').innerText = "Editar Producto";
    document.getElementById('input-type').value = item.type || '';
    document.getElementById('input-code').value = item.id;
    document.getElementById('input-code').disabled = false;
    document.getElementById('input-name').value = item.name;
    document.getElementById('input-vehicle').value = item.vehicle || '';
    document.getElementById('input-price').value = item.price;
    document.getElementById('input-stock').value = item.stock;
    document.getElementById('group-vehicle').style.display = cat === 'turbos' ? 'block' : 'none';
    
    const deleteBtn = document.getElementById('btn-delete-product');
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    
    document.getElementById('add-modal').classList.remove('hidden');
}

function openAddModal(cat) {
    editingIndex = null;
    const form = document.getElementById('add-form');
    if (form) form.reset();
    document.getElementById('modal-category').value = cat;
    document.getElementById('modal-title').innerText = "Agregar Producto";
    document.getElementById('input-code').disabled = false;
    document.getElementById('group-vehicle').style.display = cat === 'turbos' ? 'block' : 'none';
    
    const deleteBtn = document.getElementById('btn-delete-product');
    if (deleteBtn) deleteBtn.style.display = 'none';
    
    document.getElementById('add-modal').classList.remove('hidden');
}

async function deleteProductFromInventory() {
    const cat = document.getElementById('modal-category').value;
    if (editingIndex === null) return;
    
    const item = inventory[cat][editingIndex];
    if (confirm(`¿Estás seguro de que deseas eliminar el producto "${item.name}" del inventario?`)) {
        inventory[cat].splice(editingIndex, 1);
        await saveData();
        renderAll();
        closeAddModal();
    }
}

function closeAddModal() { document.getElementById('add-modal').classList.add('hidden'); }

function setupModal() {
    const form = document.getElementById('add-form');
    form.onsubmit = async (e) => {
        e.preventDefault();
        const cat = document.getElementById('modal-category').value;
        const item = {
            id: document.getElementById('input-code').value.toUpperCase(),
            type: document.getElementById('input-type').value,
            name: document.getElementById('input-name').value,
            price: parseFloat(document.getElementById('input-price').value),
            stock: parseInt(document.getElementById('input-stock').value),
            vehicle: document.getElementById('input-vehicle').value
        };
        if (editingIndex !== null) inventory[cat][editingIndex] = item; else inventory[cat].push(item);
        await saveData(); renderAll(); closeAddModal();
    };
}

function setupImport() {
    document.getElementById('import-turbos').onchange = (e) => handleImport(e, 'turbos');
    document.getElementById('import-lubricentro').onchange = (e) => handleImport(e, 'lubricentro');
}

async function handleImport(event, category) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
            let col = category === 'turbos' ? { id:1, name:2, vehicle:3, stock:6, price:7 } : { id:1, name:2, price:3, stock:6 };
            const items = [];
            for (let i = 1; i < json.length; i++) {
                const r = json[i]; if (!r[col.id]) continue;
                items.push({ id: r[col.id].toString(), name: (r[col.name]||'S/N').toString(), vehicle: col.vehicle ? (r[col.vehicle]||'').toString() : '', price: parseFloat(r[col.price])||0, stock: parseInt(r[col.stock])||0, category });
            }
            inventory[category] = items; await saveData(); renderAll(); alert("Éxito");
        } catch (err) { alert("Error"); }
    };
    reader.readAsArrayBuffer(file);
}

function setupPOS() {
    const input = document.getElementById('pos-search');
    const sugg = document.getElementById('pos-suggestions'); if (!input) return;
    input.oninput = (e) => {
        const q = e.target.value.toLowerCase(); sugg.innerHTML = '';
        if (q.length < 2) return sugg.classList.add('hidden');
        let res = [];
        ['turbos', 'lubricentro'].forEach(cat => inventory[cat].forEach((item, index) => { if (item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)) res.push({ item, cat, index }); }));
        if (res.length > 0) {
            sugg.classList.remove('hidden');
            res.forEach(r => {
                const div = document.createElement('div');
                div.className = 'suggestion-item';
                const subText = r.item.vehicle ? ` [${r.item.id}] - ${r.item.vehicle}` : ` [${r.item.id}]`;
                div.innerHTML = `<strong>${r.item.name}</strong><span style="color: var(--muted-foreground); font-size: 0.8rem; margin-left: 8px;">${subText}</span>`;
                div.onclick = () => {
                    const p = r.item; const c = p.price || 0; const d = c * DEBIT_PERCENT; const cr = c * CREDIT_PERCENT;
                    document.getElementById('pos-selected-info').innerHTML = `
                        <div class="pos-card">
                            <div class="pos-header" style="margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
                                <strong style="font-size: 1.1rem; color: var(--foreground);">${p.name}</strong>
                                <span style="font-size: 0.8rem; color: var(--muted-foreground); display: block; margin-top: 2px;">Código: ${p.id}</span>
                            </div>
                            
                            <div style="margin-bottom: 15px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                                <div>
                                    <label style="font-weight: 600; font-size: 0.9rem; color: var(--foreground);">Cant:</label>
                                    <input type="number" id="pos-edit-qty" value="1" min="1" style="max-width: 60px; font-weight: bold; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px;" oninput="updatePOSPrices()">
                                </div>
                                <div>
                                    <label style="font-weight: 600; font-size: 0.9rem; color: var(--foreground);">Precio c/u ($):</label>
                                    <input type="number" id="pos-edit-price" value="${c}" style="max-width: 100px; font-weight: bold; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px;" oninput="updatePOSPrices()">
                                </div>
                            </div>
                            
                            <div class="pos-prices">
                                <div class="price-tag cash">
                                    <span class="label">Efectivo</span>
                                    <span class="value" id="pos-price-cash">$${c.toFixed(2)}</span>
                                    <button class="btn-sell-pos cash" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Efectivo')">Vender</button>
                                </div>
                                <div class="price-tag transfer">
                                    <span class="label">Transferencia</span>
                                    <span class="value" id="pos-price-transfer">$${c.toFixed(2)}</span>
                                    <button class="btn-sell-pos transfer" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Transferencia')">Vender</button>
                                </div>
                                <div class="price-tag debit">
                                    <span class="label">Débito (6%)</span>
                                    <span class="value" id="pos-price-debit">$${d.toFixed(2)}</span>
                                    <button class="btn-sell-pos debit" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Débito')">Vender</button>
                                </div>
                                <div class="price-tag credit">
                                    <span class="label">Crédito (9.6%)</span>
                                    <span class="value" id="pos-price-credit">$${cr.toFixed(2)}</span>
                                    <button class="btn-sell-pos credit" onclick="triggerPOSSale('${r.cat}', ${r.index}, 'Crédito')">Vender</button>
                                </div>
                            </div>
                        </div>
                    `;
                    input.value = ''; sugg.classList.add('hidden');
                };
                sugg.appendChild(div);
            });
        }
    };
}

function updatePOSPrices() {
    const priceInput = document.getElementById('pos-edit-price');
    const qtyInput = document.getElementById('pos-edit-qty');
    if (!priceInput || !qtyInput) return;
    
    const price = parseFloat(priceInput.value) || 0;
    const qty = parseInt(qtyInput.value) || 1;
    const totalBase = price * qty;
    
    const debitPrice = totalBase * DEBIT_PERCENT;
    const creditPrice = totalBase * CREDIT_PERCENT;
    
    document.getElementById('pos-price-cash').innerText = `$${totalBase.toFixed(2)}`;
    document.getElementById('pos-price-transfer').innerText = `$${totalBase.toFixed(2)}`;
    document.getElementById('pos-price-debit').innerText = `$${debitPrice.toFixed(2)}`;
    document.getElementById('pos-price-credit').innerText = `$${creditPrice.toFixed(2)}`;
}

function triggerPOSSale(cat, index, method) {
    const priceInput = document.getElementById('pos-edit-price');
    const qtyInput = document.getElementById('pos-edit-qty');
    if (!priceInput || !qtyInput) return;
    
    const price = parseFloat(priceInput.value) || 0;
    const qty = parseInt(qtyInput.value) || 1;
    const totalBase = price * qty;
    
    let finalPrice = totalBase;
    if (method === 'Débito') finalPrice = totalBase * DEBIT_PERCENT;
    else if (method === 'Crédito') finalPrice = totalBase * CREDIT_PERCENT;
    
    completeSale(cat, index, finalPrice, method, qty);
}

async function completeSale(cat, index, price, method, qty = 1) {
    const item = inventory[cat][index];
    if (item.stock < qty) {
        if (!confirm(`El producto "${item.name}" tiene stock insuficiente (quedan ${item.stock}). ¿Deseas registrar la venta de ${qty} unidades de todas formas?`)) {
            return;
        }
    }
    item.stock -= qty; 
    
    const baseSaleName = qty > 1 ? `${item.name} (x${qty})` : item.name;
    const saleName = `${baseSaleName} - ${method}`;
    const newSale = { item_id: item.id, name: saleName, category: cat, price, date: new Date().toISOString() };
    
    if (client) {
        const { data } = await client.from('ventas_taller_ro').insert([newSale]).select();
        if (data && data.length > 0) sales.push(data[0]);
        else sales.push(newSale);
    } else {
        sales.push(newSale);
    }
    
    await saveData(); 
    renderAll(); 
    document.getElementById('pos-selected-info').innerHTML = '<div class="status-badge">✅ Vendido</div>';
}

async function deleteSale(id, date) {
    if (!confirm("¿Anular esta venta?")) return;
    const idx = sales.findIndex(s => (s.id == id || (s.id === undefined && id === 'undefined') || (s.id === null && id === 'null')) && s.date === date);
    if (idx > -1) {
        const s = sales[idx]; 
        const productCode = s.item_id || s.id;
        const item = inventory[s.category].find(i => i.id === productCode);
        
        let qtyToReturn = 1;
        const match = s.name.match(/\(x(\d+)\)/);
        if (match) qtyToReturn = parseInt(match[1], 10);
        
        if (item) item.stock += qtyToReturn;
        
        if (client) {
            if (s.id) await client.from('ventas_taller_ro').delete().eq('id', s.id);
            else await client.from('ventas_taller_ro').delete().eq('item_id', productCode).eq('date', date);
        }
        
        sales.splice(idx, 1); 
        await saveData(); 
        renderAll();
        
        // Refrescar el buscador de historial si está abierto en pantalla
        const resultsPanel = document.getElementById('dash-history-results');
        if (resultsPanel && !resultsPanel.classList.contains('hidden')) {
            searchVehicleHistory();
        }
    }
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => {
        document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        const activeTab = btn.dataset.tab;
        document.getElementById(activeTab).classList.add('active');
        
        // Show POS panel only on inventory tabs (turbos and lubricentro)
        const posPanel = document.querySelector('.pos-panel');
        if (posPanel) {
            if (activeTab === 'turbos' || activeTab === 'lubricentro') {
                posPanel.style.display = 'block';
            } else {
                posPanel.style.display = 'none';
            }
        }
    });
    
    // Set initial state based on active tab
    const posPanel = document.querySelector('.pos-panel');
    if (posPanel) {
        const activeBtn = document.querySelector('.tab-btn.active');
        const activeTab = activeBtn ? activeBtn.dataset.tab : 'dashboard';
        if (activeTab === 'turbos' || activeTab === 'lubricentro') {
            posPanel.style.display = 'block';
        } else {
            posPanel.style.display = 'none';
        }
    }
}

function setupSearch() {
    const st = document.getElementById('search-turbos'), sl = document.getElementById('search-lubricentro');
    if (st) st.oninput = (e) => renderTurbos(e.target.value); if (sl) sl.oninput = (e) => renderLubricentro(e.target.value);
    
    const sh = document.getElementById('dash-history-search');
    if (sh) {
        sh.onkeyup = (e) => {
            if (e.key === 'Enter') searchVehicleHistory();
        };
    }
}

function changeStock(cat, idx, amt) { if (inventory[cat][idx].stock + amt >= 0) { inventory[cat][idx].stock += amt; saveData(); renderAll(); } }

async function loadWegaExcel() {
    const status = document.getElementById('wega-status'); if (!status) return;
    try {
        const res = await fetch('precios_limpios.xlsx');
        if (!res.ok) throw new Error("No se encontró el archivo");
        const data = await res.arrayBuffer();
        processWegaData(data);
        status.innerText = "✅ Lista Lista"; status.style.background = "#dcfce7";
    } catch (e) { 
        status.innerText = "⚠️ Subir Excel"; 
        status.style.background = "#fef3c7";
    }
}

function setupWegaManualImport() {
    const input = document.getElementById('import-wega-manual');
    if (input) {
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    processWegaData(event.target.result);
                    alert("✅ Lista de filtros actualizada correctamente");
                    document.getElementById('wega-status').innerText = "✅ Lista Lista";
                    document.getElementById('wega-status').style.background = "#dcfce7";
                } catch (err) {
                    alert("Error al procesar el Excel");
                }
            };
            reader.readAsArrayBuffer(file);
        };
    }
}

function processWegaData(data) {
    const wb = XLSX.read(data);
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    
    // Columnas esperadas: Filtros, Codigo, Descripcion, Precio
    // Mapeo: [0:Filtros, 1:Codigo, 2:Descripcion, 3:Precio]
    wegaData = raw.slice(1).map(row => {
        let price = parseFloat(row[3]) || 0;
        // Lógica: si el precio es bajo (ej: 9.95), multiplicar por 1000 -> 9950
        if (price > 0 && price < 1000) price = price * 1000;
        
        return {
            category: (row[0] || '').toString().toUpperCase(),
            code: (row[1] || '').toString().toUpperCase(),
            desc: (row[2] || '').toString(),
            price: price
        };
    }).filter(item => item.code);
}

async function loadMannExcel() {
    const status = document.getElementById('mann-status'); if (!status) return;
    try {
        const res = await fetch('precios_mann.xlsx');
        if (!res.ok) throw new Error("No se encontró el archivo");
        const data = await res.arrayBuffer();
        processMannData(data);
        status.innerText = "✅ Lista Lista"; status.style.background = "#dcfce7";
    } catch (e) { 
        status.innerText = "⚠️ Subir Excel"; 
        status.style.background = "#fef3c7";
    }
}

function setupMannManualImport() {
    const input = document.getElementById('import-mann-manual');
    if (input) {
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    processMannData(event.target.result);
                    alert("✅ Lista de filtros MANN actualizada correctamente");
                    const status = document.getElementById('mann-status');
                    if (status) {
                        status.innerText = "✅ Lista Lista";
                        status.style.background = "#dcfce7";
                    }
                } catch (err) {
                    alert("Error al procesar el Excel de MANN");
                }
            };
            reader.readAsArrayBuffer(file);
        };
    }
}

function processMannData(data) {
    const wb = XLSX.read(data);
    let combinedRows = [];
    
    // Loop through all sheets in the workbook (Table 1, Table 2, etc.)
    wb.SheetNames.forEach((sheetName) => {
        const sheet = wb.Sheets[sheetName];
        const raw = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (!raw || raw.length === 0) return;
        
        // Find the header row by looking for "código" and "precio"
        let headerIdx = -1;
        for (let i = 0; i < Math.min(raw.length, 25); i++) {
            const row = raw[i];
            if (row && row.some(cell => cell && cell.toString().toLowerCase().includes('código')) &&
                row.some(cell => cell && cell.toString().toLowerCase().includes('precio'))) {
                headerIdx = i;
                break;
            }
        }
        
        // Fallback if no header row found with those keywords
        if (headerIdx === -1) {
            for (let i = 0; i < Math.min(raw.length, 10); i++) {
                if (raw[i] && raw[i].length >= 3 && raw[i][0] && raw[i][3]) {
                    headerIdx = i - 1;
                    break;
                }
            }
        }
        
        if (headerIdx === -1) headerIdx = 0;
        
        const heads = (raw[headerIdx] || []).map(h => (h || '').toString().toLowerCase().trim());
        
        let col = {
            code: heads.findIndex(h => h.includes('código') || h.includes('codigo') || h.includes('artículo') || h.includes('articulo')),
            desc: heads.findIndex(h => h.includes('resumen') || h.includes('aplicación') || h.includes('aplicacion') || h.includes('descripción') || h.includes('descripcion') || h.includes('modelo')),
            price: heads.findIndex(h => h.includes('precio') || h.includes('sin iva') || h.includes('unit')),
            class: heads.findIndex(h => h.includes('clasificación') || h.includes('clasificacion') || h.includes('tipo') || h.includes('org'))
        };
        
        if (col.code === -1) col.code = 0;
        if (col.desc === -1) col.desc = 2;
        if (col.price === -1) col.price = 3;
        if (col.class === -1) col.class = 4;
        
        const dataRows = raw.slice(headerIdx + 1);
        dataRows.forEach(row => {
            let code = (row[col.code] || '').toString().toUpperCase().trim();
            let desc = (row[col.desc] || '').toString().trim();
            let price = parseMoney(row[col.price]) || 0;
            let classification = col.class !== -1 ? (row[col.class] || '').toString().toLowerCase().trim() : '';
            
            // Skip rows that are header duplicates or empty
            if (!code || code === 'CÓDIGO' || code === 'CODIGO' || price === 0) return;
            
            // Add 12% markup as requested by the user
            price = price * 1.12;
            
            // Deduce category
            let category = '';
            const lowerDesc = desc.toLowerCase();
            const lowerClass = classification.toLowerCase();
            
            if (lowerDesc.includes('aceite') || lowerClass.includes('aceite') || code.startsWith('W ') || code.startsWith('HU') || code.startsWith('WP') || code.startsWith('W8') || code.startsWith('W9') || code.startsWith('W7')) {
                category = 'OIL';
            } else if (lowerDesc.includes('aire') || lowerClass.includes('aire') || code.startsWith('C ') || code.startsWith('CF')) {
                category = 'AIR';
            } else if (lowerDesc.includes('combustible') || lowerDesc.includes('nafta') || lowerDesc.includes('gasoil') || lowerDesc.includes('diesel') || lowerClass.includes('combustible') || lowerClass.includes('nafta') || lowerClass.includes('gasoil') || lowerClass.includes('diesel') || code.startsWith('WK') || code.startsWith('PU')) {
                category = 'FUEL';
            } else if (lowerDesc.includes('habitaculo') || lowerDesc.includes('polen') || lowerDesc.includes('cabina') || lowerClass.includes('habitaculo') || lowerClass.includes('polen') || lowerClass.includes('cabina') || code.startsWith('CU') || code.startsWith('FP')) {
                category = 'CABIN';
            }
            
            combinedRows.push({
                category: category,
                code: code,
                desc: desc,
                price: price,
                brand: 'MANN'
            });
        });
    });
    
    mannData = combinedRows;
}

function updateOilSelect() {
    const select = document.getElementById('budget-oil-select');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Seleccionar Aceite --</option>';
    
    inventory.lubricentro.forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.innerText = `${item.name} ($${item.price}/L)`;
        if (item.id === currentVal) option.selected = true;
        select.appendChild(option);
    });
}

let currentVehicleConfig = null;
let currentActiveBrand = null;

// --- IMPORTADOR DE EXCEL DE VEHÍCULOS ---
function setupVehiclesExcelImport() {
    const input = document.getElementById('import-vehicles-excel');
    if (!input) return;
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const data = new Uint8Array(event.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                // Buscar pestaña que corresponda a presupuestos o stock
                const firstSheetName = workbook.SheetNames.find(name => 
                    name.toLowerCase().includes('presupuesto') || 
                    name.toLowerCase().includes('control') || 
                    name.toLowerCase().includes('stock')
                ) || workbook.SheetNames[0];
                
                const sheet = workbook.Sheets[firstSheetName];
                const raw = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                
                if (!raw || raw.length === 0) {
                    alert("El archivo Excel está vacío.");
                    return;
                }
                
                // Encontrar fila de encabezados
                let headerIdx = -1;
                for (let i = 0; i < Math.min(raw.length, 15); i++) {
                    const row = raw[i];
                    if (row && row.some(cell => cell && cell.toString().toLowerCase().trim() === 'marca') &&
                        row.some(cell => cell && cell.toString().toLowerCase().trim() === 'modelo')) {
                        headerIdx = i;
                        break;
                    }
                }
                if (headerIdx === -1) headerIdx = 0;
                
                const dataRows = raw.slice(headerIdx + 1);
                const vehiclesList = [];
                let currentVehicle = null;
                
                for (let i = 0; i < dataRows.length; i++) {
                    const row = dataRows[i];
                    if (!row || row.length === 0) continue;
                    
                    const brand = (row[0] || '').toString().trim();
                    const model = (row[1] || '').toString().trim();
                    
                    // Si la marca o el modelo están completos, es un auto nuevo
                    if (brand || model) {
                        if (currentVehicle) {
                            vehiclesList.push(currentVehicle);
                        }
                        
                        const motor = (row[2] || '').toString().trim();
                        const year = (row[3] || '').toString().trim();
                        const oilType = (row[9] || '').toString().trim();
                        const oilLiters = parseFloat(row[10]) || 0;
                        const labor = parseMoney(row[13]) || 0;
                        const servicePrice = parseMoney(row[14]) || 0;
                        
                        const vehicleBrand = brand || "AUTO";
                        const vehicleModel = model || "S/M";
                        const nameString = `${vehicleBrand} ${vehicleModel} ${motor} ${year ? '(' + year + ')' : ''}`.replace(/\s+/g, ' ').trim().toUpperCase();
                        
                        currentVehicle = {
                            id: 'v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5) + '_' + i,
                            brand: vehicleBrand,
                            model: vehicleModel,
                            motor: motor,
                            year: year,
                            oil_type: oilType,
                            oil_liters: oilLiters,
                            labor: labor,
                            service_price: servicePrice,
                            name: nameString,
                            filters: [],
                            filter_brands: {}
                        };
                    }
                    
                    if (!currentVehicle) continue;
                    
                    // Agregar filtros de la marca de esta fila
                    const filterBrandRaw = (row[12] || '').toString().trim();
                    if (filterBrandRaw) {
                        let filterBrandClean = filterBrandRaw.toUpperCase()
                            .replace(/FILTER/g, '')
                            .replace(/\(EL KIT\)/g, '')
                            .trim();
                            
                        if (filterBrandClean.includes('WIX')) filterBrandClean = 'WIX';
                        else if (filterBrandClean.includes('MANN')) filterBrandClean = 'MANN';
                        else if (filterBrandClean.includes('FRAM')) filterBrandClean = 'FRAM';
                        else if (filterBrandClean.includes('WEGA')) filterBrandClean = 'WEGA';
                        
                        const airCode = (row[4] || '').toString().trim();
                        const oilCode = (row[5] || '').toString().trim();
                        const fuelCode = (row[6] || '').toString().trim();
                        const secondOption = (row[7] || '').toString().trim();
                        const cabinCode = (row[8] || '').toString().trim();
                        
                        if (airCode || oilCode || fuelCode || secondOption || cabinCode) {
                            currentVehicle.filter_brands[filterBrandClean] = {
                                air: airCode,
                                oil: oilCode,
                                fuel: fuelCode,
                                second_option: secondOption,
                                cabin: cabinCode
                            };
                            
                            // Guardar en array plano por compatibilidad
                            [airCode, oilCode, fuelCode, secondOption, cabinCode].forEach(c => {
                                if (c && c.toLowerCase() !== 'no lleva' && c.toLowerCase() !== 'no viene en kit' && c.toLowerCase() !== 'ni viene en kit') {
                                    if (!currentVehicle.filters.includes(c)) {
                                        currentVehicle.filters.push(c);
                                    }
                                }
                            });
                        }
                    }
                }
                
                // Cargar el último auto procesado
                if (currentVehicle) {
                    vehiclesList.push(currentVehicle);
                }
                
                if (vehiclesList.length === 0) {
                    alert("No se encontraron vehículos válidos en el archivo Excel.");
                    return;
                }
                
                // Guardar localmente y subir a Supabase
                let importedCount = 0;
                for (const v of vehiclesList) {
                    VEHICLE_DB[v.id] = v;
                    importedCount++;
                    
                    if (client && currentUser) {
                        try {
                            const dbRow = {
                                id: v.id,
                                category: 'vehicle_config',
                                name: v.name,
                                price: v.oil_liters,
                                vehicle: JSON.stringify(v)
                            };
                            await client.from('datos_taller_ro').delete().eq('id', v.id).eq('category', 'vehicle_config');
                            await client.from('datos_taller_ro').insert([dbRow]);
                        } catch (err) {
                            console.error("Error al sincronizar vehículo en Supabase:", err);
                        }
                    }
                }
                
                alert(`¡Se importaron con éxito ${importedCount} vehículos de la planilla Excel!`);
                renderAll();
                
            } catch (err) {
                console.error("Error al procesar planilla Excel:", err);
                alert("Error al procesar el archivo Excel. Asegúrate de que tenga el formato de control de stock.");
            }
        };
        reader.readAsArrayBuffer(file);
    };
}

// --- SUGERENCIAS DINÁMICAS DE VEHÍCULOS ---
function setupBudgetSuggestions() {
    const searchInput = document.getElementById('budget-search');
    const suggContainer = document.getElementById('budget-suggestions');
    if (!searchInput || !suggContainer) return;
    
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        suggContainer.innerHTML = '';
        if (query.length < 2) {
            suggContainer.classList.add('hidden');
            return;
        }
        
        const matches = Object.values(VEHICLE_DB).filter(v => {
            return (v.name || '').toLowerCase().includes(query);
        });
        
        if (matches.length > 0) {
            suggContainer.classList.remove('hidden');
            matches.slice(0, 15).forEach(v => {
                const div = document.createElement('div');
                div.innerHTML = `
                    <div class="suggestion-title">${v.name}</div>
                    <div class="suggestion-subtitle">
                        Aceite: ${v.oil_type || '-'} (${v.oil_liters || 0}L) | 
                        Mano de Obra: $${(v.labor || 0).toLocaleString('es-AR')} | 
                        Fijo Service: $${(v.service_price || 0).toLocaleString('es-AR')}
                    </div>
                `;
                div.onclick = () => {
                    loadVehicleConfig(v);
                    searchInput.value = v.name;
                    suggContainer.classList.add('hidden');
                };
                suggContainer.appendChild(div);
            });
        } else {
            suggContainer.classList.add('hidden');
        }
    });
    
    document.addEventListener('click', (e) => {
        if (e.target !== searchInput && e.target !== suggContainer) {
            suggContainer.classList.add('hidden');
        }
    });
}

// --- PRESUPUESTO INTERACTIVO ---
function setupBudget() {
    const btnSearch = document.getElementById('btn-search-budget');
    const btnSave = document.getElementById('btn-save-vehicle');
    const btnWA = document.getElementById('btn-whatsapp');
    const laborInput = document.getElementById('budget-labor');

    btnSearch.onclick = () => {
        const query = document.getElementById('budget-search').value.toLowerCase().trim();
        if (query.length < 3) return alert("Escriba marca y modelo");
        
        const matches = Object.values(VEHICLE_DB).filter(v => {
            return v.name.toLowerCase().includes(query) || query.includes(v.name.toLowerCase());
        });
        
        if (matches.length === 1) {
            loadVehicleConfig(matches[0]);
            return;
        } else if (matches.length > 1) {
            const suggContainer = document.getElementById('budget-suggestions');
            if (suggContainer) {
                suggContainer.innerHTML = '';
                suggContainer.classList.remove('hidden');
                matches.forEach(v => {
                    const div = document.createElement('div');
                    div.innerHTML = `
                        <div class="suggestion-title">${v.name}</div>
                        <div class="suggestion-subtitle">
                            Aceite: ${v.oil_type || '-'} (${v.oil_liters || 0}L) | 
                            Mano de Obra: $${(v.labor || 0).toLocaleString('es-AR')} | 
                            Fijo Service: $${(v.service_price || 0).toLocaleString('es-AR')}
                        </div>
                    `;
                    div.onclick = () => {
                        loadVehicleConfig(v);
                        document.getElementById('budget-search').value = v.name;
                        suggContainer.classList.add('hidden');
                    };
                    suggContainer.appendChild(div);
                });
            }
            return;
        }

        // Si no está en VEHICLE_DB, buscar en WEGA y MANN
        searchInWega(query);
    };

    laborInput.oninput = () => calculateBudgetTotal();
    document.getElementById('budget-oil-liters').oninput = () => calculateBudgetTotal();
    document.getElementById('budget-oil-select').onchange = () => {
        const select = document.getElementById('budget-oil-select');
        const oilId = select.value;
        const oilProd = inventory.lubricentro.find(i => i.id === oilId);
        if (oilProd) {
            currentSelection.oil_price_l = oilProd.price;
            currentSelection.oil_name = oilProd.name;
        } else {
            currentSelection.oil_price_l = 0;
            currentSelection.oil_name = null;
        }
        calculateBudgetTotal();
    };
    btnWA.onclick = () => copyBudgetToWhatsApp();
    btnSave.onclick = () => saveCurrentVehicleConfig();
}

function searchInWega(query) {
    const words = query.split(' ');
    const resultsContainer = document.getElementById('wega-results-container');
    const optionsGrid = document.getElementById('wega-options');
    optionsGrid.innerHTML = '';
    
    // Ocultar selector multimarca si buscamos manualmente en catálogos
    const selectorContainer = document.getElementById('budget-brand-selector');
    if (selectorContainer) selectorContainer.classList.add('hidden');
    
    const refCard = document.getElementById('budget-excel-reference-card');
    if (refCard) refCard.style.display = 'none';
    
    currentVehicleConfig = null;
    currentActiveBrand = null;
    
    const categories = {
        oil: { title: "🛢️ Aceite (WEO/WO / HU/WP/W)", filters: [] },
        air: { title: "🌬️ Aire (FAP/WAP / C/CF)", filters: [] },
        fuel: { title: "⛽ Combustible (FCI/FCD/FCE / WK/PU)", filters: [] },
        cabin: { title: "🏠 Habitáculo (AKX / CU/FP)", filters: [] }
    };

    // WEGA search
    wegaData.forEach(item => {
        const desc = item.desc.toLowerCase();
        const code = item.code;
        const catName = item.category.toLowerCase();
        
        if (words.every(w => desc.includes(w))) {
            let type = null;
            if (catName.includes('aceite') || code.startsWith('WEO') || code.startsWith('WO')) type = 'oil';
            else if (catName.includes('aire') || code.startsWith('FAP') || code.startsWith('WAP')) type = 'air';
            else if (catName.includes('combustible') || catName.includes('diesel') || catName.includes('inyeccion') || code.startsWith('FCI') || code.startsWith('FCD') || code.startsWith('FCE')) type = 'fuel';
            else if (catName.includes('habitaculo') || catName.includes('polen') || code.startsWith('AKX')) type = 'cabin';
            
            if (type) categories[type].filters.push({ code, desc: item.desc, price: item.price, brand: 'WEGA' });
        }
    });

    // MANN search
    mannData.forEach(item => {
        const desc = item.desc.toLowerCase();
        const code = item.code.toUpperCase().trim();
        const catName = item.category ? item.category.toLowerCase() : '';
        
        if (words.every(w => desc.includes(w))) {
            let type = null;
            if (catName.includes('oil') || code.startsWith('W ') || code.startsWith('HU') || code.startsWith('WP') || code.startsWith('W8') || code.startsWith('W9') || code.startsWith('W7')) type = 'oil';
            else if (catName.includes('air') || code.startsWith('C ') || code.startsWith('CF')) type = 'air';
            else if (catName.includes('fuel') || code.startsWith('WK') || code.startsWith('PU')) type = 'fuel';
            else if (catName.includes('cabin') || code.startsWith('CU') || code.startsWith('FP')) type = 'cabin';
            
            if (type) categories[type].filters.push({ code, desc: item.desc, price: item.price, brand: 'MANN' });
        }
    });

    Object.keys(categories).forEach(type => {
        const cat = categories[type];
        if (cat.filters.length > 0) {
            const header = document.createElement('h5'); header.innerText = cat.title;
            optionsGrid.appendChild(header);
            
            cat.filters.slice(0, 6).forEach((f, idx) => {
                const item = document.createElement('div');
                item.className = 'option-item';
                const brandColor = f.brand === 'MANN' ? '#15803d' : '#1e3a8a';
                const brandText = f.brand === 'MANN' ? 'MANN' : 'WEGA';
                
                item.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong>${f.code}</strong>
                        <span style="background:${brandColor}; color:white; font-size:0.7rem; font-weight:bold; padding:2px 6px; border-radius:4px;">${brandText}</span>
                    </div>
                    <small>${f.desc}</small>
                    <div style="color:var(--primary); font-weight:bold;">$${(f.price * 1.6).toFixed(0)}</div>
                `;
                item.onclick = () => selectFilter(type, f);
                optionsGrid.appendChild(item);
                
                if (idx === 0 && !currentSelection[type]) selectFilter(type, f);
            });
        }
    });

    resultsContainer.classList.remove('hidden');
}

function getCatalogSearchLink(brand, code) {
    if (!code) return '#';
    const cleanCode = code.trim();
    const isNoLleva = ['no lleva', 'no viene en kit', 'ni viene en kit', '-'].some(x => cleanCode.toLowerCase().includes(x));
    if (isNoLleva) return '#';
    
    // Devolvemos una búsqueda en Google del código que nos lleva directo al catálogo oficial o distribuidores
    return `https://www.google.com/search?q=${encodeURIComponent(brand + ' ' + cleanCode)}`;
}

function selectFilter(type, filter) {
    currentSelection[type] = filter;
    const container = document.getElementById(`sel-${type}`);
    if (!container) return;
    
    const isNoLleva = !filter || !filter.code || ['no lleva', 'no viene en kit', 'ni viene en kit', '-'].some(x => filter.code.toLowerCase().includes(x));
    
    if (isNoLleva) {
        container.innerHTML = `<span style="color: var(--muted-foreground);">No lleva</span>`;
        return;
    }
    
    const searchUrl = getCatalogSearchLink(filter.brand, filter.code);
    const badgeColor = filter.brand === 'MANN' ? '#15803d' : (filter.brand === 'WEGA' ? '#1e3a8a' : '#475569');
    
    container.innerHTML = `
        <span style="font-size: 0.8rem; background: ${badgeColor}; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-right: 6px; text-transform: uppercase;">${filter.brand}</span>
        <a href="${searchUrl}" target="_blank" title="Buscar en catálogo web" style="color: #4f46e5; text-decoration: underline; font-weight: bold;">${filter.code}</a>
        <a href="${searchUrl}" target="_blank" style="margin-left: 5px; text-decoration: none;" title="Buscar en catálogo">🔍</a>
    `;
    
    if (type === 'oil') {
        const q = document.getElementById('budget-search').value.toLowerCase();
        const isHeavy = ['hilux','ranger','frontier','amarok','s10','toro'].some(m => q.includes(m));
        
        // Solo sobrescribe los litros si no se cargaron previamente desde el perfil del auto
        if (!currentVehicleConfig) {
            currentSelection.oil_liters = isHeavy ? 8 : 4;
            const litersInput = document.getElementById('budget-oil-liters');
            if (litersInput) litersInput.value = currentSelection.oil_liters;
        }
        
        // Autoseleccionar aceite recomendado si no está seleccionado uno
        const select = document.getElementById('budget-oil-select');
        if (select && select.selectedIndex === 0) {
            const oilProd = inventory.lubricentro.find(o => o.name.toLowerCase().includes('5w30') || o.name.toLowerCase().includes('10w40'));
            if (oilProd) {
                select.value = oilProd.id;
                currentSelection.oil_price_l = oilProd.price;
                currentSelection.oil_name = oilProd.name;
            }
        }
    }
    
    calculateBudgetTotal();
}

function loadVehicleConfig(v) {
    currentVehicleConfig = v;
    document.getElementById('budget-search').value = v.name;
    
    // Cargar mano de obra y litros de aceite del perfil
    document.getElementById('budget-labor').value = v.labor || 0;
    document.getElementById('budget-oil-liters').value = v.oil_liters || 4;
    
    // Seleccionar automáticamente el aceite del inventario por tipo
    const select = document.getElementById('budget-oil-select');
    if (select && v.oil_type) {
        let found = false;
        const queryOil = v.oil_type.toUpperCase().replace(/\s+/g, '');
        
        for (let i = 0; i < select.options.length; i++) {
            const optText = select.options[i].text.toUpperCase().replace(/\s+/g, '');
            if (optText.includes(queryOil)) {
                select.selectedIndex = i;
                found = true;
                break;
            }
        }
        
        if (!found) {
            const mainViscosities = ["5W30", "10W40", "5W40", "15W40"];
            const matchedVisc = mainViscosities.find(visc => queryOil.includes(visc));
            if (matchedVisc) {
                for (let i = 0; i < select.options.length; i++) {
                    if (select.options[i].text.toUpperCase().includes(matchedVisc)) {
                        select.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
            }
        }
        
        if (found) {
            const oilId = select.value;
            const oilProd = inventory.lubricentro.find(item => item.id === oilId);
            if (oilProd) {
                currentSelection.oil_price_l = oilProd.price;
                currentSelection.oil_name = oilProd.name;
            }
        } else {
            select.selectedIndex = 0;
            currentSelection.oil_price_l = 0;
            currentSelection.oil_name = null;
        }
    }
    
    // Mostrar el precio fijo de planilla Excel si existe
    const refCard = document.getElementById('budget-excel-reference-card');
    const excelPriceEl = document.getElementById('budget-excel-price');
    if (refCard && excelPriceEl && v.service_price && v.service_price > 0) {
        excelPriceEl.innerText = `$${v.service_price.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        refCard.style.display = 'block';
    } else if (refCard) {
        refCard.style.display = 'none';
    }
    
    // Configurar pills del selector de marcas de filtros
    const selectorContainer = document.getElementById('budget-brand-selector');
    const pillsContainer = document.getElementById('budget-brand-pills');
    
    if (selectorContainer && pillsContainer) {
        pillsContainer.innerHTML = '';
        const brands = Object.keys(v.filter_brands || {});
        
        if (brands.length > 0) {
            selectorContainer.classList.remove('hidden');
            brands.forEach((brand, idx) => {
                const button = document.createElement('button');
                button.className = 'brand-pill';
                button.innerText = brand;
                button.onclick = () => {
                    document.querySelectorAll('.brand-pill').forEach(btn => btn.classList.remove('active'));
                    button.classList.add('active');
                    loadBrandFilters(v, brand);
                };
                pillsContainer.appendChild(button);
                
                if (idx === 0) {
                    button.classList.add('active');
                    loadBrandFilters(v, brand);
                }
            });
        } else {
            selectorContainer.classList.add('hidden');
            loadLegacyFilters(v);
        }
    } else {
        loadLegacyFilters(v);
    }
}

function loadBrandFilters(v, brand) {
    currentActiveBrand = brand;
    const filterSet = v.filter_brands[brand] || {};
    
    const types = {
        oil: filterSet.oil,
        air: filterSet.air,
        fuel: filterSet.fuel,
        cabin: filterSet.cabin
    };
    
    currentSelection.oil = null;
    currentSelection.air = null;
    currentSelection.fuel = null;
    currentSelection.cabin = null;
    
    Object.keys(types).forEach(type => {
        const code = types[type];
        if (code && code.toLowerCase() !== 'no lleva' && code.toLowerCase() !== 'no viene en kit' && code.toLowerCase() !== 'ni viene en kit' && code !== '-') {
            let item = wegaData.find(r => r.code.toUpperCase() === code.toUpperCase());
            let itemBrand = 'WEGA';
            if (!item) {
                item = mannData.find(r => r.code.toUpperCase() === code.toUpperCase());
                itemBrand = 'MANN';
            }
            if (!item) {
                itemBrand = brand;
            }
            
            const filterObj = {
                code: code,
                desc: item ? item.desc : `Filtro ${brand}`,
                price: item ? item.price : 0,
                brand: itemBrand
            };
            
            selectFilter(type, filterObj);
        } else {
            document.getElementById(`sel-${type}`).innerHTML = `<span style="color: var(--muted-foreground);">No lleva / No disponible</span>`;
        }
    });
    
    calculateBudgetTotal();
}

function loadLegacyFilters(v) {
    currentActiveBrand = null;
    currentSelection.oil = null;
    currentSelection.air = null;
    currentSelection.fuel = null;
    currentSelection.cabin = null;
    
    v.filters.forEach(code => {
        let item = wegaData.find(r => r.code === code.toUpperCase());
        let brand = 'WEGA';
        if (!item) {
            item = mannData.find(r => r.code === code.toUpperCase());
            brand = 'MANN';
        }
        
        const filterObj = { code, desc: item ? item.desc : 'Filtro Guardado', price: item ? item.price : 0, brand };
        
        if (code.startsWith('WEO') || code.startsWith('WO') || code.startsWith('W ') || code.startsWith('HU') || code.startsWith('WP') || code.startsWith('W7') || code.startsWith('W8') || code.startsWith('W9')) selectFilter('oil', filterObj);
        else if (code.startsWith('FAP') || code.startsWith('WAP') || code.startsWith('C ') || code.startsWith('CF')) selectFilter('air', filterObj);
        else if (code.startsWith('FCI') || code.startsWith('FCD') || code.startsWith('FCE') || code.startsWith('WK') || code.startsWith('PU')) selectFilter('fuel', filterObj);
        else if (code.startsWith('AKX') || code.startsWith('CU') || code.startsWith('FP')) selectFilter('cabin', filterObj);
    });

    if (v.oil_liters) currentSelection.oil_liters = v.oil_liters;
    calculateBudgetTotal();
}

function calculateBudgetTotal() {
    const itemsDiv = document.getElementById('budget-items');
    const totalDiv = document.getElementById('budget-total');
    const resultCard = document.getElementById('budget-result');
    
    itemsDiv.innerHTML = '';
    let total = 0;
    
    Object.keys(currentSelection).forEach(type => {
        const f = currentSelection[type];
        if (f && type !== 'oil_liters' && type !== 'oil_price_l' && type !== 'oil_name') {
            const price = f.price * 1.6;
            total += price;
            const priceText = price > 0 ? `$${price.toFixed(0)}` : `<span style="color:#ef4444; font-weight:600; font-size:0.8rem;">(Sin precio - Catálogo)</span>`;
            itemsDiv.innerHTML += `<p><span>[${f.brand}] ${type.toUpperCase()} (${f.code})</span> <span>${priceText}</span></p>`;
        }
    });

    const oilLiters = parseFloat(document.getElementById('budget-oil-liters').value) || 0;
    if (currentSelection.oil_price_l && oilLiters > 0) {
        const cost = currentSelection.oil_price_l * oilLiters;
        total += cost;
        itemsDiv.innerHTML += `<p><span>Aceite (${currentSelection.oil_name} x${oilLiters}L)</span> <span>$${cost.toFixed(0)}</span></p>`;
    }

    const labor = parseFloat(document.getElementById('budget-labor').value) || 0;
    if (labor > 0) {
        total += labor;
        itemsDiv.innerHTML += `<p><span>Mano de Obra</span> <span>$${labor.toFixed(0)}</span></p>`;
    }

    totalDiv.innerHTML = `<h3>Total Calculado: $${total.toFixed(0)}</h3>`;
    resultCard.classList.remove('hidden');
}

async function saveCurrentVehicleConfig() {
    const name = document.getElementById('budget-search').value;
    if (!name || !currentSelection.oil) return alert("Seleccione al menos el auto y el filtro de aceite");
    
    const v = {
        id: currentVehicleConfig ? currentVehicleConfig.id : 'v_' + Date.now(),
        name: name.toUpperCase(),
        oil_type: currentSelection.oil_name ? currentSelection.oil_name.split(' ')[0] : 'ACEITE',
        oil_liters: parseFloat(document.getElementById('budget-oil-liters').value) || 4,
        labor: parseFloat(document.getElementById('budget-labor').value) || 0,
        service_price: currentVehicleConfig ? currentVehicleConfig.service_price : 0,
        filters: [
            currentSelection.oil?.code,
            currentSelection.air?.code,
            currentSelection.fuel?.code,
            currentSelection.cabin?.code
        ].filter(f => f),
        filter_brands: currentVehicleConfig ? currentVehicleConfig.filter_brands : {}
    };
    
    // Si no tiene filter_brands, crearlo con la marca activa
    const brand = currentActiveBrand || 'MANUAL';
    if (!v.filter_brands[brand]) {
        v.filter_brands[brand] = {
            oil: currentSelection.oil?.code || '',
            air: currentSelection.air?.code || '',
            fuel: currentSelection.fuel?.code || '',
            cabin: currentSelection.cabin?.code || ''
        };
    }

    if (client) {
        const { error } = await client.from('datos_taller_ro').insert([{ category: 'vehicle_config', name: v.name, price: v.oil_liters, vehicle: JSON.stringify(v) }]);
        if (error) alert("Error: " + error.message);
        else {
            alert("¡Vehículo guardado en tu base de datos!");
            VEHICLE_DB[v.id] = v;
        }
    } else {
        VEHICLE_DB[v.id] = v;
        alert("¡Vehículo guardado localmente!");
    }
}

function copyBudgetToWhatsApp() {
    const name = document.getElementById('budget-search').value.toUpperCase();
    const items = document.getElementById('budget-items').innerText;
    const total = document.getElementById('budget-total').innerText;
    const text = `📋 *Presupuesto Service - Taller HR*\n🚗 *Vehículo:* ${name}\n\n${items}\n💰 *${total}*\n\n_Validez del presupuesto: 7 días_\n_Precios sujetos a cambios._`;
    
    navigator.clipboard.writeText(text).then(() => {
        const phone = prompt("¡Presupuesto copiado al portapapeles!\n\nSi deseas enviarlo directamente por WhatsApp, ingresa el número del cliente (ej: 5493416123456) y presiona Aceptar. Si solo querías copiarlo, presiona Cancelar:", "");
        if (phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            let formattedPhone = cleanPhone;
            if (cleanPhone.length === 10) {
                formattedPhone = '549' + cleanPhone;
            }
            const url = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(text)}`;
            window.open(url, '_blank');
        }
    });
}

async function loadCustomVehicles() {
    if (!client) return;
    const { data } = await client.from('datos_taller_ro').select('*').eq('category', 'vehicle_config');
    if (data) data.forEach(row => { 
        try {
            const v = JSON.parse(row.vehicle); 
            VEHICLE_DB[v.id || row.id] = v; 
        } catch(e) {
            console.error("Error parsing custom vehicle:", e);
        }
    });
}

// --- SERVICE MANUAL ---
function openServiceModal() {
    document.getElementById('service-id').value = '';
    const titleEl = document.querySelector('#service-modal h2');
    if (titleEl) titleEl.innerText = "⚙️ Registrar Service Manual";
    
    document.getElementById('service-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('service-plate').value = '';
    document.getElementById('service-km').value = '';
    document.getElementById('service-client').value = '';
    document.getElementById('service-phone').value = '';
    document.getElementById('service-vehicle').value = '';
    document.getElementById('service-price').value = '';
    document.getElementById('service-notes').value = '';
    document.getElementById('service-modal').classList.remove('hidden');
}

function closeServiceModal() {
    document.getElementById('service-modal').classList.add('hidden');
}

function setupServiceModal() {
    const form = document.getElementById('service-form');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const serviceId = document.getElementById('service-id').value;
        const dateVal = document.getElementById('service-date').value;
        const plate = document.getElementById('service-plate').value.toUpperCase().trim();
        const km = document.getElementById('service-km').value.trim();
        const clientName = document.getElementById('service-client').value.trim();
        const phone = document.getElementById('service-phone').value.trim();
        const vehicle = document.getElementById('service-vehicle').value.trim();
        const price = parseFloat(document.getElementById('service-price').value) || 0;
        const method = document.getElementById('service-method').value;
        const notes = document.getElementById('service-notes').value.trim();
        
        let saleName = `⚙️ SERVICE: ${vehicle}`;
        if (plate) saleName += ` [Patente: ${plate}]`;
        if (km) saleName += ` [Km: ${km}]`;
        if (clientName) saleName += ` - Cliente: ${clientName}`;
        if (phone) saleName += ` (Tel: ${phone})`;
        if (notes) saleName += ` | Notas: ${notes}`;
        saleName += ` - ${method}`;
        
        // Formatear fecha para preservar la hora al mediodía local
        const saleDate = dateVal ? new Date(dateVal + 'T12:00:00').toISOString() : new Date().toISOString();
        
        const newSale = { 
            item_id: "SERVICE", 
            name: saleName, 
            category: "lubricentro", 
            price: price, 
            date: saleDate 
        };
        
        if (serviceId) {
            newSale.id = serviceId;
            const idx = sales.findIndex(s => s.id == serviceId);
            if (idx > -1) {
                sales[idx] = newSale;
            }
            if (client) {
                try {
                    await client.from('ventas_taller_ro').update(newSale).eq('id', serviceId);
                } catch (err) {
                    console.error("Error al actualizar service en Supabase:", err);
                }
            }
        } else {
            if (client) {
                const { data } = await client.from('ventas_taller_ro').insert([newSale]).select();
                if (data && data.length > 0) sales.push(data[0]);
                else sales.push(newSale);
            } else {
                sales.push(newSale);
            }
        }
        
        await saveData();
        renderAll();
        
        // Refrescar el buscador de historial si está abierto en pantalla
        const resultsPanel = document.getElementById('dash-history-results');
        if (resultsPanel && !resultsPanel.classList.contains('hidden')) {
            searchVehicleHistory();
        }
        
        closeServiceModal();
    };
}

function openEditServiceModal(id) {
    const sale = sales.find(s => s.id == id);
    if (!sale) return;
    
    const parsed = parseServiceName(sale.name);
    if (!parsed) return;
    
    document.getElementById('service-id').value = sale.id || '';
    document.getElementById('service-date').value = sale.date ? sale.date.split('T')[0] : '';
    document.getElementById('service-plate').value = parsed.plate || '';
    document.getElementById('service-km').value = parsed.km || '';
    document.getElementById('service-client').value = parsed.client || '';
    document.getElementById('service-phone').value = parsed.phone || '';
    document.getElementById('service-vehicle').value = parsed.vehicle || '';
    document.getElementById('service-price').value = sale.price || '';
    document.getElementById('service-notes').value = parsed.notes || '';
    
    // Guess payment method
    let paymentMethod = 'Efectivo';
    const methodMatch = sale.name.match(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/);
    if (methodMatch) paymentMethod = methodMatch[1];
    else paymentMethod = guessPaymentMethod(sale);
    document.getElementById('service-method').value = paymentMethod;
    
    // Change modal title to edit mode
    const titleEl = document.querySelector('#service-modal h2');
    if (titleEl) titleEl.innerText = "⚙️ Editar Service Manual";
    
    document.getElementById('service-modal').classList.remove('hidden');
}

// --- RECEPCION DE TURBOS ---
function calculateDaysInShop(dateIngress, dateDelivery, status) {
    if (!dateIngress) return 0;
    const start = new Date(dateIngress);
    const end = (status === 'Entregado' && dateDelivery) ? new Date(dateDelivery) : new Date();
    
    start.setHours(0,0,0,0);
    end.setHours(0,0,0,0);
    
    const diffTime = end - start;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return diffDays >= 0 ? diffDays : 0;
}

function renderReceptions(filter = '') {
    const tbody = document.querySelector('#table-reception tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    // Calculate and display monthly collected subtotal and stats for receptions
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const todayStr = today.toISOString().split('T')[0];
    const currentYearMonth = `${yyyy}-${mm}`;
    
    const prevMonthDate = new Date(yyyy, today.getMonth() - 1, 1);
    const prevY = prevMonthDate.getFullYear();
    const prevM = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
    const prevYearMonth = `${prevY}-${prevM}`;
    
    let sumToday = 0;
    let sumMonth = 0;
    let sumPrevMonth = 0;
    let sumUnpaid = 0;
    
    receptions.forEach(r => {
        const cost = parseFloat(r.price) || 0;
        if (r.paymentStatus === 'Pagado') {
            const payDate = r.dateDelivery || r.dateIngress || '';
            if (payDate === todayStr) {
                sumToday += cost;
            }
            if (payDate.startsWith(currentYearMonth)) {
                sumMonth += cost;
            }
            if (payDate.startsWith(prevYearMonth)) {
                sumPrevMonth += cost;
            }
        } else {
            sumUnpaid += cost;
        }
    });
    
    const elToday = document.getElementById('reception-sum-today');
    const elMonth = document.getElementById('reception-sum-month');
    const elPrevMonth = document.getElementById('reception-sum-prev-month');
    const elUnpaid = document.getElementById('reception-sum-unpaid');
    
    if (elToday) elToday.innerText = `$${sumToday.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elMonth) elMonth.innerText = `$${sumMonth.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elPrevMonth) elPrevMonth.innerText = `$${sumPrevMonth.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elUnpaid) elUnpaid.innerText = `$${sumUnpaid.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    const filtered = receptions.filter(r => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return r.clientName?.toLowerCase().includes(q) ||
               r.contact?.toLowerCase().includes(q) ||
               r.turboDetails?.toLowerCase().includes(q);
    });
    
    filtered.sort((a, b) => new Date(b.dateIngress) - new Date(a.dateIngress)).forEach(r => {
        const tr = document.createElement('tr');
        
        const fIngress = r.dateIngress ? r.dateIngress.split('-').reverse().join('/') : '-';
        const fDelivery = r.dateDelivery ? r.dateDelivery.split('-').reverse().join('/') : '-';
        
        const days = calculateDaysInShop(r.dateIngress, r.dateDelivery, r.deliveryStatus);
        
        const budgetBadge = `<span class="status-badge ${r.budgetStatus === 'Presupuestado' ? 'badge-budget-presupuestado' : 'badge-budget-no'}">${r.budgetStatus}</span>`;
        const deliveryBadge = `<span class="status-badge ${r.deliveryStatus === 'Entregado' ? 'badge-delivery-entregado' : 'badge-delivery-no'}">${r.deliveryStatus}</span>`;
        const paymentBadge = `<span class="status-badge ${r.paymentStatus === 'Pagado' ? 'badge-payment-pagado' : 'badge-payment-no'}">${r.paymentStatus}</span>`;
        
        let methodClass = 'badge-other';
        if (r.paymentMethod === 'Efectivo') methodClass = 'badge-cash';
        else if (r.paymentMethod === 'Transferencia') methodClass = 'badge-transfer';
        else if (r.paymentMethod === 'Débito') methodClass = 'badge-debit';
        else if (r.paymentMethod === 'Crédito') methodClass = 'badge-credit';
        
        const methodBadge = r.paymentMethod && r.paymentMethod !== '-' ? `<span class="payment-badge ${methodClass}">${r.paymentMethod}</span>` : '-';
        const safeCost = parseFloat(r.price) || 0;
        
        tr.innerHTML = `
            <td>${fIngress}</td>
            <td><strong>${r.clientName}</strong></td>
            <td>${r.contact}</td>
            <td>${r.turboDetails}</td>
            <td>${budgetBadge}</td>
            <td>$${safeCost.toFixed(2)}</td>
            <td>${deliveryBadge}</td>
            <td style="text-align: center;"><strong>${days}</strong></td>
            <td>${paymentBadge}</td>
            <td>${methodBadge}</td>
            <td>${fDelivery}</td>
            <td>
                <div style="display: flex; gap: 4px; align-items: center;">
                    <button style="background:#3b82f6; color:white; border-radius:4px; border:none; padding:3px 6px; cursor:pointer;" onclick="openEditReceptionModal('${r.id}')" title="Editar">✏️</button>
                    <button style="background:#25d366; color:white; border-radius:4px; border:none; padding:3px 6px; cursor:pointer; font-weight:bold;" onclick="openWhatsAppModal('${r.id}')" title="Notificar por WhatsApp">💬</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openEditReceptionModal(id) {
    const rec = receptions.find(r => r.id === id);
    if (!rec) return;
    
    document.getElementById('reception-id').value = rec.id;
    document.getElementById('reception-modal-title').innerText = "Editar Recepción de Turbo";
    document.getElementById('reception-date-ingress').value = rec.dateIngress || '';
    document.getElementById('reception-date-delivery').value = rec.dateDelivery || '';
    document.getElementById('reception-client-name').value = rec.clientName || '';
    document.getElementById('reception-contact').value = rec.contact || '';
    document.getElementById('reception-turbo-details').value = rec.turboDetails || '';
    document.getElementById('reception-budget-status').value = rec.budgetStatus || 'No presupuestado';
    document.getElementById('reception-cost').value = rec.price || 0;
    document.getElementById('reception-delivery-status').value = rec.deliveryStatus || 'No entregado';
    document.getElementById('reception-payment-status').value = rec.paymentStatus || 'No pagado';
    document.getElementById('reception-payment-method').value = rec.paymentMethod || '-';
    
    const deleteBtn = document.getElementById('btn-delete-reception');
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    
    document.getElementById('reception-modal').classList.remove('hidden');
}

function openReceptionModal() {
    document.getElementById('reception-id').value = 'r_' + Date.now();
    document.getElementById('reception-modal-title').innerText = "Nueva Recepción de Turbo";
    document.getElementById('reception-date-ingress').value = new Date().toISOString().split('T')[0];
    document.getElementById('reception-date-delivery').value = '';
    document.getElementById('reception-client-name').value = '';
    document.getElementById('reception-contact').value = '';
    document.getElementById('reception-turbo-details').value = '';
    document.getElementById('reception-budget-status').value = 'No presupuestado';
    document.getElementById('reception-cost').value = 0;
    document.getElementById('reception-delivery-status').value = 'No entregado';
    document.getElementById('reception-payment-status').value = 'No pagado';
    document.getElementById('reception-payment-method').value = '-';
    
    const deleteBtn = document.getElementById('btn-delete-reception');
    if (deleteBtn) deleteBtn.style.display = 'none';
    
    document.getElementById('reception-modal').classList.remove('hidden');
}

function closeReceptionModal() {
    document.getElementById('reception-modal').classList.add('hidden');
}

async function saveReception(rec) {
    const idx = receptions.findIndex(r => r.id === rec.id);
    if (idx > -1) {
        receptions[idx] = rec;
    } else {
        receptions.push(rec);
    }
    
    localStorage.setItem('taller_receptions', JSON.stringify(receptions));
    
    if (client && currentUser) {
        try {
            const row = {
                id: rec.id,
                category: 'reception_turbo',
                name: rec.clientName,
                vehicle: JSON.stringify(rec)
            };
            await client.from('datos_taller_ro').delete().eq('id', rec.id).eq('category', 'reception_turbo');
            await client.from('datos_taller_ro').insert([row]);
        } catch (e) {
            console.error("Error al guardar recepción en la nube:", e);
        }
    }
    
    renderAll();
}

async function deleteReception() {
    const id = document.getElementById('reception-id').value;
    if (!id) return;
    
    const idx = receptions.findIndex(r => r.id === id);
    if (idx > -1) {
        const rec = receptions[idx];
        if (confirm(`¿Estás seguro de que deseas eliminar la recepción de "${rec.clientName}"?`)) {
            receptions.splice(idx, 1);
            localStorage.setItem('taller_receptions', JSON.stringify(receptions));
            
            if (client && currentUser) {
                try {
                    await client.from('datos_taller_ro').delete().eq('id', id).eq('category', 'reception_turbo');
                } catch (e) {
                    console.error("Error al borrar recepción en la nube:", e);
                }
            }
            
            renderAll();
            closeReceptionModal();
        }
    }
}

function setupReception() {
    const searchInput = document.getElementById('search-reception');
    if (searchInput) {
        searchInput.oninput = (e) => renderReceptions(e.target.value);
    }
    
    const form = document.getElementById('reception-form');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        
        const rec = {
            id: document.getElementById('reception-id').value,
            dateIngress: document.getElementById('reception-date-ingress').value,
            dateDelivery: document.getElementById('reception-date-delivery').value,
            clientName: document.getElementById('reception-client-name').value,
            contact: document.getElementById('reception-contact').value,
            turboDetails: document.getElementById('reception-turbo-details').value,
            budgetStatus: document.getElementById('reception-budget-status').value,
            price: parseFloat(document.getElementById('reception-cost').value) || 0,
            deliveryStatus: document.getElementById('reception-delivery-status').value,
            paymentStatus: document.getElementById('reception-payment-status').value,
            paymentMethod: document.getElementById('reception-payment-method').value
        };
        
        if (rec.deliveryStatus === 'Entregado' && !rec.dateDelivery) {
            rec.dateDelivery = new Date().toISOString().split('T')[0];
        }
        
        await saveReception(rec);
        closeReceptionModal();
    };
}

// --- CONTROL DE GASTOS ---
function renderExpenses(filter = '') {
    const tbody = document.querySelector('#table-expense tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    // Calculate and display stats
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const todayStr = today.toISOString().split('T')[0];
    const currentYearMonth = `${yyyy}-${mm}`;
    
    const prevMonthDate = new Date(yyyy, today.getMonth() - 1, 1);
    const prevY = prevMonthDate.getFullYear();
    const prevM = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
    const prevYearMonth = `${prevY}-${prevM}`;
    
    let sumToday = 0;
    let sumMonth = 0;
    let sumPrevMonth = 0;
    
    expenses.forEach(e => {
        const amt = parseFloat(e.amount) || 0;
        const eDate = e.date || '';
        if (eDate === todayStr) {
            sumToday += amt;
        }
        if (eDate.startsWith(currentYearMonth)) {
            sumMonth += amt;
        }
        if (eDate.startsWith(prevYearMonth)) {
            sumPrevMonth += amt;
        }
    });
    
    const elToday = document.getElementById('expense-sum-today');
    const elMonth = document.getElementById('expense-sum-month');
    const elPrevMonth = document.getElementById('expense-sum-prev-month');
    
    if (elToday) elToday.innerText = `$${sumToday.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elMonth) elMonth.innerText = `$${sumMonth.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elPrevMonth) elPrevMonth.innerText = `$${sumPrevMonth.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    // Filter and render list
    const filtered = expenses.filter(e => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return (e.name || '').toLowerCase().includes(q) ||
               (e.category || '').toLowerCase().includes(q) ||
               (e.notes || '').toLowerCase().includes(q);
    });
    
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(e => {
        const tr = document.createElement('tr');
        const fDate = e.date ? e.date.split('-').reverse().join('/') : '-';
        const amt = parseFloat(e.amount) || 0;
        
        let methodClass = 'badge-other';
        if (e.paymentMethod === 'Efectivo') methodClass = 'badge-cash';
        else if (e.paymentMethod === 'Transferencia') methodClass = 'badge-transfer';
        else if (e.paymentMethod === 'Débito') methodClass = 'badge-debit';
        else if (e.paymentMethod === 'Crédito') methodClass = 'badge-credit';
        
        const methodBadge = e.paymentMethod ? `<span class="payment-badge ${methodClass}">${e.paymentMethod}</span>` : '-';
        
        tr.innerHTML = `
            <td>${fDate}</td>
            <td><strong>${e.name || ''}</strong></td>
            <td><span class="status-badge" style="background-color: #64748b; color: white;">${e.category || ''}</span></td>
            <td style="color: #991b1b; font-weight: bold;">$${amt.toFixed(2)}</td>
            <td>${methodBadge}</td>
            <td style="font-size: 0.85rem; color: var(--muted-foreground);">${e.notes || ''}</td>
            <td>
                <button style="background:#3b82f6; color:white; border-radius:4px; border:none; padding:3px 6px; cursor:pointer;" onclick="openEditExpenseModal('${e.id}')" title="Editar">✏️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openExpenseModal() {
    document.getElementById('expense-id').value = 'exp_' + Date.now();
    document.getElementById('expense-modal-title').innerText = "Nuevo Gasto / Compra";
    document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('expense-name').value = '';
    document.getElementById('expense-category').value = 'Proveedor';
    document.getElementById('expense-amount').value = '';
    document.getElementById('expense-payment-method').value = 'Efectivo';
    document.getElementById('expense-notes').value = '';
    
    const deleteBtn = document.getElementById('btn-delete-expense');
    if (deleteBtn) deleteBtn.style.display = 'none';
    
    document.getElementById('expense-modal').classList.remove('hidden');
}

function openEditExpenseModal(id) {
    const exp = expenses.find(e => e.id === id);
    if (!exp) return;
    
    document.getElementById('expense-id').value = exp.id;
    document.getElementById('expense-modal-title').innerText = "Editar Gasto / Compra";
    document.getElementById('expense-date').value = exp.date || '';
    document.getElementById('expense-name').value = exp.name || '';
    document.getElementById('expense-category').value = exp.category || 'Proveedor';
    document.getElementById('expense-amount').value = exp.amount || '';
    document.getElementById('expense-payment-method').value = exp.paymentMethod || 'Efectivo';
    document.getElementById('expense-notes').value = exp.notes || '';
    
    const deleteBtn = document.getElementById('btn-delete-expense');
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    
    document.getElementById('expense-modal').classList.remove('hidden');
}

function closeExpenseModal() {
    document.getElementById('expense-modal').classList.add('hidden');
}

async function saveExpense(exp) {
    const idx = expenses.findIndex(e => e.id === exp.id);
    if (idx > -1) {
        expenses[idx] = exp;
    } else {
        expenses.push(exp);
    }
    
    // Save locally
    localStorage.setItem('taller_expenses', JSON.stringify(expenses));
    
    // Save to Supabase
    if (client && currentUser) {
        try {
            const row = {
                id: exp.id,
                category: 'expense',
                name: exp.name,
                price: exp.amount,
                vehicle: JSON.stringify(exp)
            };
            await client.from('datos_taller_ro').delete().eq('id', exp.id).eq('category', 'expense');
            await client.from('datos_taller_ro').insert([row]);
        } catch (e) {
            console.error("Error al guardar gasto en la nube:", e);
        }
    }
    
    renderAll();
}

async function deleteExpense() {
    const id = document.getElementById('expense-id').value;
    if (!id) return;
    
    const idx = expenses.findIndex(e => e.id === id);
    if (idx > -1) {
        const exp = expenses[idx];
        if (confirm(`¿Estás seguro de que deseas eliminar el gasto "${exp.name}"?`)) {
            expenses.splice(idx, 1);
            localStorage.setItem('taller_expenses', JSON.stringify(expenses));
            
            if (client && currentUser) {
                try {
                    await client.from('datos_taller_ro').delete().eq('id', id).eq('category', 'expense');
                } catch (e) {
                    console.error("Error al borrar gasto en la nube:", e);
                }
            }
            
            renderAll();
            closeExpenseModal();
        }
    }
}

function setupExpense() {
    const searchInput = document.getElementById('search-expense');
    if (searchInput) {
        searchInput.oninput = (e) => renderExpenses(e.target.value);
    }
    
    const form = document.getElementById('expense-form');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        
        const exp = {
            id: document.getElementById('expense-id').value,
            date: document.getElementById('expense-date').value,
            name: document.getElementById('expense-name').value,
            category: document.getElementById('expense-category').value,
            amount: parseFloat(document.getElementById('expense-amount').value) || 0,
            paymentMethod: document.getElementById('expense-payment-method').value,
            notes: document.getElementById('expense-notes').value
        };
        
        await saveExpense(exp);
        closeExpenseModal();
    };
}

// --- ALERTA DE STOCK Y PEDIDO DE REPOSICION ---
let stockOrderItems = [];

function openStockOrderModal() {
    updateStockOrderList();
    document.getElementById('stock-order-modal').classList.remove('hidden');
}

function closeStockOrderModal() {
    document.getElementById('stock-order-modal').classList.add('hidden');
}

function updateStockOrderList() {
    const threshLub = parseInt(document.getElementById('order-threshold-lub').value, 10) || 0;
    const threshTurbo = parseInt(document.getElementById('order-threshold-turbo').value, 10) || 0;
    
    const tbody = document.querySelector('#table-low-stock tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    stockOrderItems = [];
    
    // Check Lubricentro
    inventory.lubricentro.forEach(item => {
        if (item.stock <= threshLub) {
            stockOrderItems.push({ ...item, categoryLabel: 'Lubricentro', defaultOrder: Math.max(1, 10 - item.stock) });
        }
    });
    
    // Check Turbos
    inventory.turbos.forEach(item => {
        if (item.stock <= threshTurbo) {
            stockOrderItems.push({ ...item, categoryLabel: 'Turbos', defaultOrder: 1 });
        }
    });
    
    if (stockOrderItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--muted-foreground);">🎉 Todos los productos tienen stock suficiente.</td></tr>`;
        document.getElementById('order-preview-text').value = '';
        return;
    }
    
    stockOrderItems.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';
        
        tr.innerHTML = `
            <td style="padding: 8px;">${item.categoryLabel}</td>
            <td style="padding: 8px;"><strong>${item.id}</strong></td>
            <td style="padding: 8px;">${item.name}</td>
            <td style="padding: 8px; text-align: center; font-weight: bold; color: var(--destructive);">${item.stock}</td>
            <td style="padding: 8px; text-align: center;">
                <input type="number" id="order-qty-${index}" value="${item.defaultOrder}" min="0" style="width: 70px; height: 1.8rem; text-align: center; border-radius: 6px; border: 1px solid var(--border);" oninput="generateOrderPreview()">
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    generateOrderPreview();
}

function generateOrderPreview() {
    const textArea = document.getElementById('order-preview-text');
    if (!textArea) return;
    
    if (stockOrderItems.length === 0) {
        textArea.value = '';
        return;
    }
    
    let text = `📋 *Pedido de Reposición - Taller HR*\n\nHola, necesito realizar el siguiente pedido de mercadería:\n`;
    let hasItemsToOrder = false;
    
    stockOrderItems.forEach((item, index) => {
        const input = document.getElementById(`order-qty-${index}`);
        const qty = input ? parseInt(input.value, 10) : item.defaultOrder;
        
        if (qty > 0) {
            text += `- *[${item.id}]* ${item.name} (Pedir ${qty} unid.)\n`;
            hasItemsToOrder = true;
        }
    });
    
    text += `\n¡Muchas gracias! Quedo a la espera de la confirmación.`;
    
    if (!hasItemsToOrder) {
        textArea.value = 'No has especificado cantidades para pedir.';
    } else {
        textArea.value = text;
    }
}

function copyStockOrderToClipboard() {
    const text = document.getElementById('order-preview-text').value;
    if (!text || text.startsWith('No has')) return alert("No hay items para copiar");
    
    navigator.clipboard.writeText(text).then(() => {
        alert("📋 ¡Lista de pedido copiada al portapapeles! Ya puedes pegarla en WhatsApp.");
    });
}

function sendStockOrderWhatsApp() {
    const text = document.getElementById('order-preview-text').value;
    if (!text || text.startsWith('No has')) return alert("No hay items para enviar");
    
    const phone = prompt("Ingresa el número de WhatsApp de tu distribuidor o proveedor (ej: 5493416123456) para enviarle el mensaje directamente. De lo contrario, presiona Cancelar:", "");
    if (phone) {
        const cleanPhone = phone.replace(/\D/g, '');
        let formattedPhone = cleanPhone;
        if (cleanPhone.length === 10) {
            formattedPhone = '549' + cleanPhone;
        }
        const url = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
    }
}

// --- WHATSAPP NOTIFICATIONS FOR RECEPTIONS ---
function openWhatsAppModal(id) {
    const rec = receptions.find(r => r.id === id);
    if (!rec) return;
    
    document.getElementById('wa-reception-id').value = rec.id;
    
    // Clean and prefill phone number (keep only digits)
    let rawContact = rec.contact || '';
    let cleanPhone = rawContact.replace(/\D/g, ''); 
    
    // Auto-prefill country code for Argentina (549) if it has 10 digits
    if (cleanPhone.length === 10) {
        cleanPhone = '549' + cleanPhone;
    } else if (cleanPhone.length === 11 && cleanPhone.startsWith('9')) {
        cleanPhone = '54' + cleanPhone;
    } else if (cleanPhone.length === 13 && cleanPhone.startsWith('5415')) {
        cleanPhone = '549' + cleanPhone.substring(4);
    }
    
    document.getElementById('wa-phone').value = cleanPhone;
    
    // Set default template based on reception status
    const select = document.getElementById('wa-template-select');
    if (rec.deliveryStatus === 'Entregado') {
        select.value = 'entrega';
    } else if (rec.budgetStatus === 'Presupuestado') {
        select.value = 'presupuesto';
    } else {
        select.value = 'ingreso';
    }
    
    updateWhatsAppMessageTemplate();
    document.getElementById('whatsapp-modal').classList.remove('hidden');
}

function closeWhatsAppModal() {
    document.getElementById('whatsapp-modal').classList.add('hidden');
}

function updateWhatsAppMessageTemplate() {
    const id = document.getElementById('wa-reception-id').value;
    const rec = receptions.find(r => r.id === id);
    if (!rec) return;
    
    const templateType = document.getElementById('wa-template-select').value;
    const clientName = rec.clientName || 'Cliente';
    const turboDetails = rec.turboDetails || 'Turbo';
    const safeCost = parseFloat(rec.price) || 0;
    const fCost = `$${safeCost.toFixed(2)}`;
    const fIngress = rec.dateIngress ? rec.dateIngress.split('-').reverse().join('/') : '';
    const paymentStatus = rec.paymentStatus === 'Pagado' ? 'PAGADO' : 'PENDIENTE DE PAGO';
    
    let text = '';
    
    if (templateType === 'ingreso') {
        text = `🔧 *Ingreso de Turbo - Taller HR*\n\nHola *${clientName}*, te confirmamos que tu turbo *${turboDetails}* ingresó al taller en la fecha *${fIngress}*.\n\nEn breve nuestro equipo técnico comenzará con la revisión para realizar el diagnóstico y presupuesto. Nos contactaremos con vos apenas tengamos novedades.\n\n¡Muchas gracias!`;
    } else if (templateType === 'presupuesto') {
        text = `📋 *Presupuesto Listo - Taller HR*\n\nHola *${clientName}*, ya tenemos el diagnóstico de tu turbo *${turboDetails}*.\n\n💰 *Costo de reparación:* ${fCost}\n💳 *Estado de pago:* ${paymentStatus}\n⏱️ *Validez del presupuesto:* 7 días\n\nPor favor, confirmanos si procedemos con la reparación del mismo.\n\nCualquier duda quedamos a disposición. ¡Saludos!`;
    } else if (templateType === 'entrega') {
        const paymentInfo = rec.paymentStatus === 'Pagado' ? 'El mismo ya se encuentra registrado como PAGADO.' : `Costo: ${fCost} (${paymentStatus}).`;
        text = `🚗 *Listo para Retirar - Taller HR*\n\nHola *${clientName}*, te informamos que el trabajo en tu turbo *${turboDetails}* ha sido completado con éxito.\n\nYa podés pasar a retirarlo por el taller.\n\nℹ️ *Información:* ${paymentInfo}\n\n¡Te esperamos! Saludos del equipo de Taller HR.`;
    }
    
    document.getElementById('wa-message-text').value = text;
}

function setupWhatsApp() {
    const form = document.getElementById('whatsapp-form');
    if (!form) return;
    form.onsubmit = (e) => {
        e.preventDefault();
        const phone = document.getElementById('wa-phone').value.trim();
        const text = document.getElementById('wa-message-text').value;
        
        // Open WhatsApp Web
        const url = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
        closeWhatsAppModal();
    };
}

function renderDashboard() {
    const elSalesToday = document.getElementById('dash-sales-today');
    if (!elSalesToday) return;
    
    const todayStr = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    
    let salesToday = 0;
    let countToday = 0;
    let salesMonth = 0;
    let countMonth = 0;
    
    let payCash = 0;
    let payTransfer = 0;
    let payDebit = 0;
    let payCredit = 0;
    
    sales.forEach(s => {
        const sDate = new Date(s.date);
        const sDateStr = s.date.split('T')[0];
        const sPrice = parseFloat(s.price) || 0;
        
        if (sDateStr === todayStr) {
            salesToday += sPrice;
            countToday++;
        }
        
        if (sDate.getMonth() === currentMonth && sDate.getFullYear() === currentYear) {
            salesMonth += sPrice;
            countMonth++;
            
            let paymentMethod = 'Efectivo';
            const methodMatch = s.name.match(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/);
            if (methodMatch) {
                paymentMethod = methodMatch[1];
            } else {
                paymentMethod = guessPaymentMethod(s);
            }
            
            if (paymentMethod === 'Efectivo') payCash += sPrice;
            else if (paymentMethod === 'Transferencia') payTransfer += sPrice;
            else if (paymentMethod === 'Débito') payDebit += sPrice;
            else if (paymentMethod === 'Crédito') payCredit += sPrice;
        }
    });
    
    elSalesToday.innerText = `$${salesToday.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('dash-sales-count-today').innerText = `${countToday} transacciones`;
    
    document.getElementById('dash-sales-month').innerText = `$${salesMonth.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('dash-sales-count-month').innerText = `${countMonth} transacciones`;
    
    const turbosInTaller = receptions.filter(r => r.deliveryStatus !== 'Entregado');
    document.getElementById('dash-turbos-taller').innerText = turbosInTaller.length;
    
    const turbosNotBudgeted = receptions.filter(r => r.deliveryStatus !== 'Entregado' && r.budgetStatus !== 'Presupuestado');
    document.getElementById('dash-turbos-pending').innerText = `${turbosNotBudgeted.length} sin presupuestar`;
    
    let lowStockCount = 0;
    const threshLub = parseInt(document.getElementById('order-threshold-lub')?.value || '3', 10);
    const threshTurbo = parseInt(document.getElementById('order-threshold-turbo')?.value || '2', 10);
    inventory.lubricentro.forEach(i => { if (i.stock <= threshLub) lowStockCount++; });
    inventory.turbos.forEach(i => { if (i.stock <= threshTurbo) lowStockCount++; });
    document.getElementById('dash-low-stock').innerText = lowStockCount;
    
    document.getElementById('dashboard-update-time').innerText = `Actualizado: ${new Date().toLocaleTimeString('es-AR')}`;
    
    const totalPayMonth = payCash + payTransfer + payDebit + payCredit;
    const getPercent = (val) => totalPayMonth > 0 ? (val / totalPayMonth) * 100 : 0;
    
    const barsContainer = document.getElementById('payment-methods-bars');
    if (barsContainer) {
        barsContainer.innerHTML = `
            <div>
                <div style="display:flex; justify-content:space-between; font-size:0.85rem; font-weight:600; margin-bottom:5px;">
                    <span style="color:#16a34a;">💵 Efectivo (${getPercent(payCash).toFixed(1)}%)</span>
                    <span>$${payCash.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style="background:#e5e7eb; height:10px; border-radius:5px; overflow:hidden;">
                    <div style="background:#16a34a; height:100%; width:${getPercent(payCash)}%; border-radius:5px;"></div>
                </div>
            </div>
            <div>
                <div style="display:flex; justify-content:space-between; font-size:0.85rem; font-weight:600; margin-bottom:5px;">
                    <span style="color:#7c3aed;">💜 Transferencia (${getPercent(payTransfer).toFixed(1)}%)</span>
                    <span>$${payTransfer.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style="background:#e5e7eb; height:10px; border-radius:5px; overflow:hidden;">
                    <div style="background:#7c3aed; height:100%; width:${getPercent(payTransfer)}%; border-radius:5px;"></div>
                </div>
            </div>
            <div>
                <div style="display:flex; justify-content:space-between; font-size:0.85rem; font-weight:600; margin-bottom:5px;">
                    <span style="color:#2563eb;">💳 Débito (${getPercent(payDebit).toFixed(1)}%)</span>
                    <span>$${payDebit.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style="background:#e5e7eb; height:10px; border-radius:5px; overflow:hidden;">
                    <div style="background:#2563eb; height:100%; width:${getPercent(payDebit)}%; border-radius:5px;"></div>
                </div>
            </div>
            <div>
                <div style="display:flex; justify-content:space-between; font-size:0.85rem; font-weight:600; margin-bottom:5px;">
                    <span style="color:#dc2626;">💳 Crédito (${getPercent(payCredit).toFixed(1)}%)</span>
                    <span>$${payCredit.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
                </div>
                <div style="background:#e5e7eb; height:10px; border-radius:5px; overflow:hidden;">
                    <div style="background:#dc2626; height:100%; width:${getPercent(payCredit)}%; border-radius:5px;"></div>
                </div>
            </div>
        `;
    }
    
    const recNotDelivered = receptions.filter(r => r.deliveryStatus !== 'Entregado').length;
    const recDelivered = receptions.filter(r => r.deliveryStatus === 'Entregado').length;
    const recNotBudgetedCount = receptions.filter(r => r.budgetStatus !== 'Presupuestado').length;
    const recUnpaid = receptions.filter(r => r.paymentStatus !== 'Pagado').length;
    
    document.getElementById('dash-rec-not-delivered').innerText = recNotDelivered;
    document.getElementById('dash-rec-delivered').innerText = recDelivered;
    document.getElementById('dash-rec-not-budgeted').innerText = recNotBudgetedCount;
    document.getElementById('dash-rec-unpaid').innerText = recUnpaid;
    
    const deliveredItems = receptions.filter(r => r.deliveryStatus === 'Entregado' && r.dateIngress && r.dateDelivery);
    let totalDays = 0;
    deliveredItems.forEach(r => {
        totalDays += calculateDaysInShop(r.dateIngress, r.dateDelivery, 'Entregado');
    });
    const avgDays = deliveredItems.length > 0 ? (totalDays / deliveredItems.length).toFixed(1) : 0;
    document.getElementById('dash-rec-avg-days').innerText = `${avgDays} días`;

    // Calculate monthly balance
    let expensesMonth = 0;
    expenses.forEach(e => {
        if (e.date) {
            const eDate = new Date(e.date + 'T12:00:00');
            if (eDate.getMonth() === currentMonth && eDate.getFullYear() === currentYear) {
                expensesMonth += parseFloat(e.amount) || 0;
            }
        }
    });

    let receptionsMonth = 0;
    receptions.forEach(r => {
        if (r.paymentStatus === 'Pagado') {
            const rDateStr = r.dateDelivery || r.dateIngress || '';
            if (rDateStr) {
                const rDate = new Date(rDateStr + 'T12:00:00');
                if (rDate.getMonth() === currentMonth && rDate.getFullYear() === currentYear) {
                    receptionsMonth += parseFloat(r.price) || 0;
                }
            }
        }
    });

    const totalIngresos = salesMonth + receptionsMonth;
    const balance = totalIngresos - expensesMonth;

    const elBalance = document.getElementById('dash-balance-month');
    const elBalanceDetails = document.getElementById('dash-balance-details');
    if (elBalance) {
        elBalance.innerText = `$${balance.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        if (balance >= 0) {
            elBalance.style.color = '#10b981';
        } else {
            elBalance.style.color = '#ef4444';
        }
    }
    if (elBalanceDetails) {
        elBalanceDetails.innerText = `Ingresos: $${totalIngresos.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} | Gastos: $${expensesMonth.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
}

// --- DECODIFICADOR DE DETALLES DE SERVICES MANUALES ---
function parseServiceName(name) {
    if (!name || !name.includes('SERVICE:')) return null;
    
    const plateMatch = name.match(/\[Patente:\s*([^\]]+)\]/i);
    const kmMatch = name.match(/\[Km:\s*([^\]]+)\]/i);
    const clientMatch = name.match(/-\s*Cliente:\s*([^\(|\||-]+)/i);
    const phoneMatch = name.match(/\(Tel:\s*([^\)]+)\)/i);
    const notesMatch = name.match(/\|\s*Notas:\s*([^|-]+)/i);
    
    let vehicle = '';
    const serviceIndex = name.indexOf('SERVICE:');
    if (serviceIndex !== -1) {
        const start = serviceIndex + 8;
        const end = name.search(/\[|-|\|/);
        vehicle = end !== -1 ? name.substring(start, end).trim() : name.substring(start).trim();
    }
    
    return {
        vehicle: vehicle || 'Servicio General',
        plate: plateMatch ? plateMatch[1].trim() : '',
        km: kmMatch ? kmMatch[1].trim() : '',
        client: clientMatch ? clientMatch[1].trim() : '',
        phone: phoneMatch ? phoneMatch[1].trim() : '',
        notes: notesMatch ? notesMatch[1].trim() : ''
    };
}

// --- BUSCADOR DE HISTORIAL DE VEHICULOS (FICHA TÉCNICA) ---
function searchVehicleHistory() {
    const input = document.getElementById('dash-history-search');
    const resultsContainer = document.getElementById('dash-history-results');
    const timeline = document.getElementById('dash-history-timeline');
    const title = document.getElementById('dash-history-title');
    
    if (!input || !resultsContainer || !timeline || !title) return;
    
    const query = input.value.trim().toLowerCase();
    if (!query) {
        resultsContainer.classList.add('hidden');
        return;
    }
    
    timeline.innerHTML = '';
    
    // 1. Filtrar ventas
    const matchedSales = sales.filter(s => {
        const name = (s.name || '').toLowerCase();
        const itemId = (s.item_id || '').toLowerCase();
        const category = (s.category || '').toLowerCase();
        return name.includes(query) || itemId.includes(query) || category.includes(query);
    }).map(s => {
        const parsed = parseServiceName(s.name);
        return {
            type: 'sale',
            isService: !!parsed,
            serviceDetails: parsed,
            date: new Date(s.date),
            rawDate: s.date,
            category: s.category,
            name: s.name,
            price: parseFloat(s.price) || 0,
            itemId: s.item_id,
            id: s.id
        };
    });
    
    // 2. Filtrar recepciones de turbos
    const matchedReceptions = receptions.filter(r => {
        const client = (r.clientName || '').toLowerCase();
        const contact = (r.contact || '').toLowerCase();
        const details = (r.turboDetails || '').toLowerCase();
        const budget = (r.budgetStatus || '').toLowerCase();
        const delivery = (r.deliveryStatus || '').toLowerCase();
        const payment = (r.paymentStatus || '').toLowerCase();
        const method = (r.paymentMethod || '').toLowerCase();
        
        return client.includes(query) || 
               contact.includes(query) || 
               details.includes(query) || 
               budget.includes(query) || 
               delivery.includes(query) || 
               payment.includes(query) || 
               method.includes(query);
    }).map(r => ({
        type: 'reception',
        date: r.dateIngress ? new Date(r.dateIngress + 'T00:00:00') : new Date(),
        rawDate: r.dateIngress,
        clientName: r.clientName,
        contact: r.contact,
        turboDetails: r.turboDetails,
        budgetStatus: r.budgetStatus,
        deliveryStatus: r.deliveryStatus,
        paymentStatus: r.paymentStatus,
        paymentMethod: r.paymentMethod,
        price: parseFloat(r.price) || 0,
        dateDelivery: r.dateDelivery
    }));
    
    const combined = [...matchedSales, ...matchedReceptions];
    
    if (combined.length === 0) {
        title.innerText = `No se encontraron resultados para "${input.value}"`;
        timeline.innerHTML = `<div style="text-align: center; padding: 15px; color: var(--muted-foreground);">Ningún servicio, venta o recepción coincide con el término de búsqueda.</div>`;
        resultsContainer.classList.remove('hidden');
        return;
    }
    
    title.innerText = `Resultados para "${input.value}" (${combined.length} encontrados)`;
    
    // 3. Agrupar los services manuales por patente o auto para crear la "Ficha Técnica"
    const servicesByVehicle = {};
    const otherEvents = [];
    
    combined.forEach(item => {
        if (item.type === 'sale' && item.isService && item.serviceDetails) {
            const sd = item.serviceDetails;
            const groupKey = sd.plate ? sd.plate.toUpperCase() : `VEHICULO:${sd.vehicle.toUpperCase()}`;
            
            if (!servicesByVehicle[groupKey]) {
                servicesByVehicle[groupKey] = {
                    vehicle: sd.vehicle,
                    plate: sd.plate,
                    client: sd.client,
                    phone: sd.phone,
                    history: []
                };
            }
            servicesByVehicle[groupKey].history.push(item);
            
            if (!servicesByVehicle[groupKey].client && sd.client) servicesByVehicle[groupKey].client = sd.client;
            if (!servicesByVehicle[groupKey].phone && sd.phone) servicesByVehicle[groupKey].phone = sd.phone;
        } else {
            otherEvents.push(item);
        }
    });
    
    // 4. Renderizar las Fichas Técnicas agrupadas
    Object.keys(servicesByVehicle).forEach(key => {
        const group = servicesByVehicle[key];
        group.history.sort((a, b) => b.date - a.date);
        
        const card = document.createElement('div');
        card.className = 'ficha-tecnica-card';
        card.style.background = 'white';
        card.style.border = '1px solid var(--border)';
        card.style.borderRadius = '12px';
        card.style.padding = '20px';
        card.style.marginBottom = '20px';
        card.style.boxShadow = 'var(--shadow-md)';
        card.style.borderLeft = '6px solid #4f46e5';
        card.style.textAlign = 'left';
        
        let headerHtml = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                <div>
                    <span style="background: #e0e7ff; color: #4f46e5; font-size: 0.75rem; font-weight: 800; padding: 3px 8px; border-radius: 6px; text-transform: uppercase;">🚗 FICHA TÉCNICA UNIFICADA</span>
                    <h2 style="font-family: 'Montserrat', sans-serif; font-size: 1.2rem; font-weight: 800; color: var(--dark-bg); margin-top: 5px;">${group.vehicle}</h2>
                    ${group.client ? `<p style="font-size: 0.85rem; color: var(--muted-foreground); margin-top: 3px;"><strong>Cliente:</strong> ${group.client} ${group.phone ? `| <strong>Tel:</strong> ${group.phone}` : ''}</p>` : ''}
                </div>
                ${group.plate ? `
                <div style="background: #1e293b; color: white; padding: 6px 14px; border-radius: 8px; border: 2px solid #cbd5e1; font-family: 'Montserrat', sans-serif; font-weight: 900; font-size: 1.1rem; letter-spacing: 0.05em; text-align: center; box-shadow: var(--shadow-sm);">
                    ${group.plate}
                </div>` : ''}
            </div>
        `;
        
        let rowsHtml = '';
        group.history.forEach(item => {
            const sd = item.serviceDetails;
            const dateStr = item.date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const priceFormatted = `$${item.price.toLocaleString('es-AR')}`;
            
            let paymentMethod = '-';
            const methodMatch = item.name.match(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/);
            if (methodMatch) paymentMethod = methodMatch[1];
            else paymentMethod = guessPaymentMethod(item);
            
            let badgeClass = 'badge-other';
            if (paymentMethod === 'Efectivo') badgeClass = 'badge-cash';
            else if (paymentMethod === 'Transferencia') badgeClass = 'badge-transfer';
            else if (paymentMethod === 'Débito') badgeClass = 'badge-debit';
            else if (paymentMethod === 'Crédito') badgeClass = 'badge-credit';
            
            const kmText = sd.km ? `${parseFloat(sd.km).toLocaleString('es-AR')} Km` : '-';
            
            rowsHtml += `
                <tr style="border-bottom: 1px solid #f1f5f9;">
                    <td style="padding: 10px 8px; font-weight: 600; color: #475569; white-space: nowrap;">📅 ${dateStr}</td>
                    <td style="padding: 10px 8px; font-weight: 700; color: #0f172a; white-space: nowrap;">${kmText}</td>
                    <td style="padding: 10px 8px; color: #334155; max-width: 300px; word-break: break-word;">${sd.notes || 'Service general'}</td>
                    <td style="padding: 10px 8px; font-weight: 700; color: var(--primary); white-space: nowrap;">${priceFormatted}</td>
                    <td style="padding: 10px 8px; white-space: nowrap;"><span class="payment-badge ${badgeClass}" style="font-size: 0.7rem; padding: 2px 6px;">${paymentMethod}</span></td>
                    <td style="padding: 10px 8px; text-align: center; white-space: nowrap;">
                        <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
                            <button style="color: #3b82f6; border: none; background: none; cursor: pointer; font-weight: bold; font-size: 1.1rem; padding: 2px 4px;" onclick="openEditServiceModal('${item.id}')" title="Editar este service">✏️</button>
                            <button style="color: #ef4444; border: none; background: none; cursor: pointer; font-weight: bold; font-size: 1.1rem; padding: 2px 4px;" onclick="deleteSale('${item.id}', '${item.rawDate}')" title="Anular este service">🗑️</button>
                        </div>
                    </td>
                </tr>
            `;
        });
        
        const tableHtml = `
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <thead>
                        <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: var(--muted-foreground); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em;">
                            <th style="padding: 8px; text-align: left;">Fecha</th>
                            <th style="padding: 8px; text-align: left;">Kilómetros</th>
                            <th style="padding: 8px; text-align: left;">Trabajo Realizado / Notas</th>
                            <th style="padding: 8px; text-align: left;">Precio</th>
                            <th style="padding: 8px; text-align: left;">Cobro</th>
                            <th style="padding: 8px; text-align: center; width: 80px;">Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
        `;
        
        card.innerHTML = headerHtml + tableHtml;
        timeline.appendChild(card);
    });
    
    // 5. Renderizar otros eventos (ventas directas o recepciones de turbos)
    if (otherEvents.length > 0) {
        otherEvents.sort((a, b) => b.date - a.date);
        
        const otherTitle = document.createElement('h4');
        otherTitle.innerText = "Otros Eventos del Historial";
        otherTitle.style.marginTop = '25px';
        otherTitle.style.marginBottom = '12px';
        otherTitle.style.fontFamily = "'Montserrat', sans-serif";
        otherTitle.style.fontWeight = '800';
        otherTitle.style.fontSize = '1rem';
        otherTitle.style.color = 'var(--muted-foreground)';
        otherTitle.style.borderBottom = '1px solid var(--border)';
        otherTitle.style.paddingBottom = '6px';
        otherTitle.style.textAlign = 'left';
        timeline.appendChild(otherTitle);
        
        otherEvents.forEach(item => {
            const div = document.createElement('div');
            const dStr = item.date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            
            if (item.type === 'sale') {
                let paymentMethod = '-';
                let displayName = item.name;
                const methodMatch = item.name.match(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/);
                if (methodMatch) {
                    paymentMethod = methodMatch[1];
                    displayName = item.name.replace(/\s-\s(Efectivo|Transferencia|Débito|Crédito)$/, '');
                } else {
                    paymentMethod = guessPaymentMethod(item);
                }
                
                let badgeClass = 'badge-other';
                if (paymentMethod === 'Efectivo') badgeClass = 'badge-cash';
                else if (paymentMethod === 'Transferencia') badgeClass = 'badge-transfer';
                else if (paymentMethod === 'Débito') badgeClass = 'badge-debit';
                else if (paymentMethod === 'Crédito') badgeClass = 'badge-credit';
                
                const categoryLabel = item.category === 'turbos' ? 'VENTA TURBO' : 'VENTA LUBRICENTRO';
                const badgeColor = item.category === 'turbos' ? '#b91c1c' : '#dc2626';
                
                div.innerHTML = `
                    <div class="timeline-item" style="background: white; border-left: 4px solid ${badgeColor}; padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); border-left-width: 4px; box-shadow: var(--shadow-sm); margin-bottom: 8px; text-align: left;">
                        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--muted-foreground); margin-bottom:5px;">
                            <span>📅 ${dStr}</span>
                            <span style="background: #fee2e2; color: #b91c1c; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.7rem;">${categoryLabel}</span>
                        </div>
                        <div style="font-weight: 700; font-size: 0.9rem; color: var(--dark-bg);">${displayName}</div>
                        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:0.8rem; flex-wrap:wrap; gap:5px;">
                            <span style="color:var(--muted-foreground);">Cobro: <span class="payment-badge ${badgeClass}" style="padding: 1px 6px; font-size: 0.7rem;">${paymentMethod}</span></span>
                            <strong style="color: var(--foreground); font-size: 0.85rem;">$${item.price.toFixed(2)}</strong>
                        </div>
                    </div>
                `;
            } else {
                const days = calculateDaysInShop(item.rawDate, item.dateDelivery, item.deliveryStatus);
                
                const budgetBadge = `<span class="status-badge ${item.budgetStatus === 'Presupuestado' ? 'badge-budget-presupuestado' : 'badge-budget-no'}" style="padding: 1px 6px; font-size: 0.7rem;">${item.budgetStatus}</span>`;
                const deliveryBadge = `<span class="status-badge ${item.deliveryStatus === 'Entregado' ? 'badge-delivery-entregado' : 'badge-delivery-no'}" style="padding: 1px 6px; font-size: 0.7rem;">${item.deliveryStatus}</span>`;
                const paymentBadge = `<span class="status-badge ${item.paymentStatus === 'Pagado' ? 'badge-payment-pagado' : 'badge-payment-no'}" style="padding: 1px 6px; font-size: 0.7rem;">${item.paymentStatus}</span>`;
                
                let methodClass = 'badge-other';
                if (item.paymentMethod === 'Efectivo') methodClass = 'badge-cash';
                else if (item.paymentMethod === 'Transferencia') methodClass = 'badge-transfer';
                else if (item.paymentMethod === 'Débito') methodClass = 'badge-debit';
                else if (item.paymentMethod === 'Crédito') methodClass = 'badge-credit';
                const methodBadge = item.paymentMethod && item.paymentMethod !== '-' ? `<span class="payment-badge ${methodClass}" style="padding: 1px 6px; font-size: 0.7rem;">${item.paymentMethod}</span>` : '-';
                
                const rawDateObj = item.rawDate ? new Date(item.rawDate + 'T00:00:00') : new Date();
                const dateStrFormatted = rawDateObj.toLocaleDateString('es-AR');
                
                div.innerHTML = `
                    <div class="timeline-item" style="background: white; border-left: 4px solid #d97706; padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); border-left-width: 4px; box-shadow: var(--shadow-sm); margin-bottom: 8px; text-align: left;">
                        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--muted-foreground); margin-bottom:5px;">
                            <span>📅 ${dateStrFormatted} (Ingreso)</span>
                            <span style="background: #fffbeb; color: #92400e; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.7rem;">TALLER DE TURBOS</span>
                        </div>
                        <div style="font-weight: 700; font-size: 0.9rem; color: var(--dark-bg);">${item.turboDetails}</div>
                        <div style="font-size: 0.8rem; color: var(--muted-foreground); margin-top: 3px;">
                            Cliente: <strong>${item.clientName}</strong> ${item.contact ? `| Tel: ${item.contact}` : ''}
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:8px;">
                            ${budgetBadge} ${deliveryBadge} ${paymentBadge} ${item.paymentMethod && item.paymentMethod !== '-' ? methodBadge : ''}
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:0.8rem; border-top:1px dashed var(--border); padding-top:6px; margin-top:6px;">
                            <span style="color:var(--muted-foreground);">Taller: <strong>${days} días</strong> ${item.dateDelivery ? `(Entregado: ${new Date(item.dateDelivery + 'T00:00:00').toLocaleDateString('es-AR')})` : ''}</span>
                            <strong style="color: var(--foreground); font-size: 0.85rem;">$${item.price.toFixed(2)}</strong>
                        </div>
                    </div>
                `;
            }
            
            timeline.appendChild(div);
        });
    }
    
    resultsContainer.classList.remove('hidden');
}

async function apply21PercentIncrease() {
    if (!confirm("¿Estás seguro de que deseas aumentar el precio de todos los productos de Lubricentro en un 21%? (Se exceptuarán los aceites VALVOLINE DEXRON3 ATF HIDRAULICO y VALVOLINE 5W30 ACEA C3 x LITRO).")) {
        return;
    }
    
    let count = 0;
    inventory.lubricentro.forEach(item => {
        const nameUpper = item.name.toUpperCase();
        // Verificar las excepciones exactas y sus términos clave
        const isDexron = nameUpper.includes("VALVOLINE DEXRON3 ATF HIDRAULICO") || nameUpper.includes("DEXRON3");
        const is5w30c3 = nameUpper.includes("VALVOLINE 5W30 ACEA C3") || (nameUpper.includes("5W30") && nameUpper.includes("C3"));
        
        if (!isDexron && !is5w30c3) {
            const oldPrice = parseFloat(item.price) || 0;
            item.price = Math.round(oldPrice * 1.21 * 100) / 100; // Redondear a 2 decimales para evitar problemas de precisión
            count++;
        }
    });
    
    await saveData();
    renderAll();
    alert(`¡Éxito! Se actualizaron los precios de ${count} productos en un 21%.`);
}

init();
