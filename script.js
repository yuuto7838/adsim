// Game State
const state = {
    view: 'API_KEY', // API_KEY, LOADING, BRIEF, PLANNING, RUNNING, RESULT, CHALLENGE
    apiKey: localStorage.getItem('gemini_api_key') || '',
    brief: null,
    allocation: { google: 0, meta: 0, tiktok: 0 },
    results: null,
    history: [],
    qaHistory: [],
    date: { year: 1, month: 1 },
    modal: null, // 'HISTORY', 'BRIEF', 'CHANNEL_INFO', null
    challenge: null // { question: "", answer: "", feedback: "", score: 0 }
};

// --- GenAI Integration ---
const GEMINI_MODEL = "gemini-2.5-flash";

async function callGemini(prompt, isJson = false) {
    if (!state.apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${state.apiKey}`;
    const finalPrompt = isJson
        ? prompt + "\n\nResponse must be valid JSON only. No markdown formatting."
        : prompt;

    const payload = { contents: [{ parts: [{ text: finalPrompt }] }] };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        let text = data.candidates[0].content.parts[0].text;
        if (isJson) text = text.replace(/```json\n?|\n?```/g, '').trim();
        return isJson ? JSON.parse(text) : text;
    } catch (e) {
        console.error("Gemini API Error:", e);
        alert("API Error: " + e.message);
        return null;
    }
}

async function generateBriefWithGemini() {
    setView('LOADING');
    const prompt = `
        You are a simulator engine for an ad agency game in Japan. Create a fictional client scenario.
        Return ONLY a JSON object with the following fields (ALL text content MUST be in Japanese):
        - clientName: string (Fictional Company Name in Japanese)
        - product: string (Product/Service Name in Japanese)
        - objective: string (Campaign Objective in Japanese)
        - productDetails: string (Detailed description of product, 2-3 sentences in Japanese)
        - challenges: string (Bulleted list of 3 marketing challenges in Japanese)
        - budget: number (Between 500,000 and 5,000,000 JPY)
        - targetCPA: number (Appropriate CPA for the industry, in JPY)
        - minROAS: number (Between 1.5 and 4.0)
        - audience: string (Target Audience description in Japanese)
        - bestChannel: string (One of: "google", "meta", "tiktok")

        The industry can be Random (SaaS, E-commerce, Game, B2B, Recruitment, Real Estate, etc).
        Ensure all text values are in natural business Japanese.
    `;

    const brief = await callGemini(prompt, true);
    if (brief) {
        state.brief = brief;
        state.allocation = { google: 0, meta: 0, tiktok: 0 };
        state.results = null;
        state.history = [];
        state.qaHistory = [];
        state.date = { year: 1, month: 1 };
        setView('BRIEF');
    } else {
        setView('API_KEY');
    }
}

async function handleQuestionSubmit() {
    const input = document.getElementById('chat-input');
    const question = input.value.trim();
    if (!question) return;
    state.qaHistory.push({ q: question, a: "..." });
    input.value = '';
    render();

    const brief = state.brief;
    const prompt = `
        You are the client "${brief.clientName}".
        The user is your ad agency partner.
        Context: Product=${brief.product}, Budget=¥${brief.budget}, Audience=${brief.audience}, BestChannel=${brief.bestChannel}
        User asks: "${question}"
        Answer in charater (Polite Japanese). Short. Don't spoil BestChannel directly.
    `;
    const answer = await callGemini(prompt, false);
    if (answer) state.qaHistory[state.qaHistory.length - 1].a = answer;
    else state.qaHistory[state.qaHistory.length - 1].a = "Error.";
    render();
}

async function generateChallenge() {
    setView('LOADING');
    const recent = state.results;
    const prompt = `
        You are the client "${state.brief.clientName}". It is the end of Quarter Review (3 months passed).
        Recent Monthly Result: Spend=¥${recent.total.spend}, CPA=¥${recent.total.cpa}, ROAS=${recent.total.roas.toFixed(2)}.
        Target: CPA < ¥${state.brief.targetCPA}, ROAS > ${state.brief.minROAS}.
        
        Ask the user ONE tough question about the results or their strategy.
        Examples:
        - "Why is the CPA higher than target?"
        - "Why did you allocate so much budget to [Channel with high spend]?"
        - "We need better ROAS. What is your plan?"
        
        Return ONLY the question string in Japanese.
    `;
    const question = await callGemini(prompt, false);
    state.challenge = { question, answer: "", feedback: "", score: 0 };
    setView('CHALLENGE');
}

async function submitChallengeAnswer() {
    const input = document.getElementById('challenge-input');
    const userAns = input.value.trim();
    if (!userAns) return;

    state.challenge.answer = userAns;
    // Show loading state for feedback
    const btn = document.getElementById('challenge-submit-btn');
    btn.textContent = "クライアントが確認中...";
    btn.disabled = true;

    const prompt = `
        You are the client. You asked: "${state.challenge.question}"
        User answered: "${userAns}"
        
        Evaluate the answer based on:
        1. Logical consistency with marketing principles.
        2. Professionalism.
        3. Alignment with the results (Spend: ${state.results.total.spend}, CPA: ${state.results.total.cpa}).
        
        Return a JSON object:
        {
            "score": number (1-10),
            "feedback": string (Your reaction/comment in Japanese. Be strict but fair.),
            "budgetBonus": number (If score >= 8, give bonus amount e.g. 500000. If score <= 3, negative amount. Else 0.)
        }
    `;

    const result = await callGemini(prompt, true);
    state.challenge.feedback = result.feedback;
    state.challenge.score = result.score;

    // Apply bonus/penalty
    if (result.budgetBonus !== 0) {
        state.brief.budget += result.budgetBonus;
    }

    render();
}

// --- Standard Logic ---
function runSimulation() {
    let totalSpend = 0, totalConv = 0, totalRev = 0;
    const channelResults = {};
    const channels = {
        google: { baseCPA: 4500, cpm: 500, ctr: 0.02, cvr: 0.05, roas: 2.5 },
        meta: { baseCPA: 3000, cpm: 800, ctr: 0.015, cvr: 0.04, roas: 3.0 },
        tiktok: { baseCPA: 2000, cpm: 400, ctr: 0.01, cvr: 0.03, roas: 1.5 }
    };
    const bestChannel = state.brief.bestChannel || 'google';

    for (const [channel, amount] of Object.entries(state.allocation)) {
        if (amount <= 0) { channelResults[channel] = null; continue; }
        const info = channels[channel];
        let luck = 0.8 + Math.random() * 0.4;
        if (channel === bestChannel.toLowerCase()) luck += 0.3;

        const cpm = info.cpm / luck;
        const ctr = info.ctr * luck;
        const cvr = info.cvr * luck;
        const impressions = Math.floor((amount / cpm) * 1000);
        const clicks = Math.floor(impressions * ctr);
        const conversions = Math.floor(clicks * cvr);
        const revenue = amount * info.roas * luck;
        const cpa = conversions > 0 ? amount / conversions : 0;
        const roas = amount > 0 ? revenue / amount : 0;

        channelResults[channel] = { spend: amount, impressions, clicks, conversions, revenue, cpa, cpm, ctr, cvr, roas };
        totalSpend += amount;
        totalConv += conversions;
        totalRev += revenue;
    }
    const overallCPA = totalConv > 0 ? (totalSpend / totalConv) : 0;
    const overallROAS = totalSpend > 0 ? (totalRev / totalSpend) : 0;

    return {
        date: { ...state.date },
        total: { spend: totalSpend, conversions: totalConv, revenue: totalRev, cpa: overallCPA, roas: overallROAS },
        channels: channelResults
    };
}

// --- UI Actions & state updates ---
function nextMonth() {
    // Increment Date
    state.date.month++;
    if (state.date.month > 12) {
        state.date.month = 1;
        state.date.year++;
    }

    // Check for Quarterly Event: Every 3rd month (3, 6, 9, 12... wait, after result of month 3?)
    // Logic: result is for month X. Next is month X+1.
    // Let's trigger Challenge AFTER Month 3 result, before moving to Month 4 Planning.
    // Actually, easy way: if (history.length % 3 === 0) -> Challenge.

    // Reset allocation for new month
    state.allocation = { google: 0, meta: 0, tiktok: 0 };

    if (state.history.length > 0 && state.history.length % 3 === 0 && state.view !== 'CHALLENGE') {
        generateChallenge();
        return;
    }

    setView('PLANNING');
}

function saveApiKey() {
    const input = document.getElementById('api-key-input');
    const key = input.value.trim();
    if (key) {
        state.apiKey = key;
        localStorage.setItem('gemini_api_key', key);
        generateBriefWithGemini();
    }
}
function clearApiKey() {
    state.apiKey = '';
    localStorage.removeItem('gemini_api_key');
    setView('API_KEY');
}
const formatCurrency = (val) => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(val);
const formatNum = (val) => new Intl.NumberFormat('ja-JP').format(val);
const formatPercent = (val) => (val * 100).toFixed(2) + '%';
function setView(view) { state.view = view; state.modal = null; render(); }
function setModal(modal) { state.modal = modal; render(); }
function closeModal() { state.modal = null; render(); }

function handleAllocationChange(channel, value) {
    state.allocation[channel] = parseInt(value) || 0;
    const total = Object.values(state.allocation).reduce((a, b) => a + b, 0);
    const remElem = document.getElementById('remaining-budget');
    const btn = document.getElementById('execute-btn');
    if (remElem) {
        remElem.textContent = formatCurrency(state.brief.budget - total);
        remElem.style.color = (state.brief.budget - total) < 0 ? 'var(--accent-danger)' : 'white';
    }
    if (btn) btn.disabled = (state.brief.budget - total) < 0;
}
function handleRun() {
    setView('RUNNING');
    setTimeout(() => {
        state.results = runSimulation();
        state.history.push(state.results);
        setView('RESULT');
    }, 1000);
}

// --- Renderers ---
function renderApiKeyModal() {
    return `
        <div class="modal-overlay">
            <div class="modal">
                <h2>API Keyの設定</h2>
                <p>Gemini APIキーを入力してスタート</p>
                <input type="password" id="api-key-input" placeholder="AIzaSy..." style="width:100%; padding:0.8rem; margin: 1rem 0; box-sizing:border-box; background:rgba(0,0,0,0.3); color:white; border:1px solid var(--border-color); border-radius:6px;">
                <button class="btn-primary" onclick="saveApiKey()">開始する</button>
            </div>
        </div>
    `;
}

function renderLoading() {
    return `
        <div style="display:flex; justify-content:center; align-items:center; height:100vh; flex-direction:column;">
            <div style="width:40px; height:40px; border:4px solid var(--accent-primary); border-top-color:transparent; border-radius:50%; animation: spin 1s linear infinite;"></div>
            <p style="margin-top:1rem;">思考中...</p>
        </div>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `;
}

function renderHeader() {
    if (!state.brief) return '';
    return `
        <header>
            <div style="display:flex; align-items:center; gap:1rem;">
                <h1 style="margin:0; font-size:1.5rem;">AdSim</h1>
                <div style="background:rgba(255,255,255,0.1); padding:0.2rem 0.8rem; border-radius:20px; font-size:0.9rem;">
                    ${state.date.year}年目 ${state.date.month}月
                </div>
            </div>
            <div style="display:flex; align-items:center;">
                <div style="text-align:right; margin-right:1rem;">
                    <div style="color: var(--text-secondary); font-size:0.8rem;">クライアント</div>
                    <div style="font-weight:bold">${state.brief.clientName}</div>
                </div>
                <button class="header-btn" onclick="setModal('BRIEF')">案件情報</button>
                <button class="header-btn" onclick="setModal('HISTORY')">履歴</button>
                <button class="header-btn" onclick="clearApiKey()">設定リセット</button>
            </div>
        </header>
    `;
}

function renderBrief() {
    // Used for Initial View
    const b = state.brief;
    return `
        <div class="glass-panel" style="max-width: 700px; margin: 0 auto; text-align: left;">
            <h2 style="text-align:center">新規案件のご相談 (AI Generated)</h2>
            <div style="margin-bottom: 2rem;">
                <h3 style="color: var(--accent-primary); border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">プロジェクト概要</h3>
                <p style="font-size: 1.1rem; line-height: 1.6;">${b.objective}</p>
            </div>
            <div style="margin-bottom: 2rem;">
                <h3 style="color: var(--accent-primary); border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">商材詳細</h3>
                <p style="line-height: 1.6;">${b.productDetails}</p>
            </div>
            <div style="margin-bottom: 2rem;">
                <h3 style="color: var(--accent-primary); border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">現在の課題</h3>
                <p style="white-space: pre-line; line-height: 1.6;">${b.challenges}</p>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; background: rgba(255,255,255,0.05); padding: 1rem; border-radius: 8px;">
                <div><strong>予算:</strong> ${formatCurrency(b.budget)}</div>
                <div><strong>目標KPI:</strong> CPA < ${formatCurrency(b.targetCPA)}</div>
                <div style="grid-column: 1 / -1; margin-top:0.5rem"><strong>ターゲット:</strong> ${b.audience}</div>
            </div>
            <div style="text-align: center;">
                <button class="btn-primary" onclick="setView('PLANNING')">案件を受注する</button>
                <div style="margin-top: 1rem; font-size: 0.8rem; color: #666; cursor: pointer" onclick="generateBriefWithGemini()">別の案件を探す (リロード)</div>
            </div>
        </div>
    `;
}

function renderModal() {
    if (!state.modal) return '';
    let content = '';

    if (state.modal === 'BRIEF') {
        const b = state.brief;
        content = `
            <h2>案件情報</h2>
            <div style="text-align:left; max-height:60vh; overflow-y:auto;">
                <p><strong>クライアント:</strong> ${b.clientName}</p>
                <p><strong>商材:</strong> ${b.product} (${b.productDetails})</p>
                <p><strong>課題:</strong><br>${b.challenges}</p>
                <p><strong>ターゲット:</strong> ${b.audience}</p>
                <p><strong>予算:</strong> ${formatCurrency(b.budget)}</p>
                <p><strong>目標CPA:</strong> ${formatCurrency(b.targetCPA)}</p>
                <p><strong>目標ROAS:</strong> ${b.minROAS.toFixed(2)}</p>
            </div>
        `;
    } else if (state.modal === 'HISTORY') {
        if (state.history.length === 0) {
            content = `<h2>配信履歴</h2><p>まだデータがありません。</p>`;
        } else {
            const rows = state.history.map((h) => `
                <tr>
                    <td style="text-align:left">${h.date.year}年${h.date.month}月</td>
                    <td>${formatCurrency(h.total.spend)}</td>
                    <td>${formatNum(h.total.conversions)}</td>
                    <td>${formatCurrency(h.total.cpa)}</td>
                    <td>${h.total.roas.toFixed(2)}</td>
                </tr>
            `).join('');
            content = `
                <h2>配信履歴</h2>
                <div style="max-height:60vh; overflow-y:auto;">
                    <table class="history-table">
                        <thead><tr><th>年月</th><th>Cost</th><th>CV</th><th>CPA</th><th>ROAS</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        }
    } else if (state.modal === 'CHANNEL_INFO') {
        content = `
            <h2>媒体特性</h2>
            <div class="channel-card">
                <h4>Google 広告</h4>
                <div class="channel-tag">検索連動</div> <div class="channel-tag">高Intent</div>
                <p>ユーザーが能動的に検索するため、CVRが高い傾向にある。ただし競合も多く、クリック単価(CPC)は高騰しやすい。B2Bや緊急性の高いサービスに向く。</p>
            </div>
            <div class="channel-card">
                <h4>Meta (Facebook/IG)</h4>
                <div class="channel-tag">精密ターゲティング</div> <div class="channel-tag">ビジュアル</div>
                <p>実名登録ベースの精度の高いターゲティングが可能。詳細なペルソナ（年齢・趣味・職種）に合わせた配信が得意。潜在層へのアプローチに最適。</p>
            </div>
            <div class="channel-card">
                <h4>TikTok</h4>
                <div class="channel-tag">爆発的拡散</div> <div class="channel-tag">若年層</div>
                <p>おすすめフィードによる拡散力が高い。クリエイティブの鮮度が重要で、摩耗が早い。10代〜20代向けや、視覚的インパクトの強い商材に強い。</p>
            </div>
        `;
    }

    return `
        <div class="modal-overlay" onclick="closeModal()">
            <div class="modal" onclick="event.stopPropagation()">
                ${content}
                <button class="btn-primary" style="margin-top:1rem;" onclick="closeModal()">閉じる</button>
            </div>
        </div>
    `;
}

function renderChallenge() {
    const c = state.challenge;
    const isDone = c.feedback !== "";

    return `
        ${renderHeader()}
        <div class="glass-panel" style="max-width:700px; margin:2rem auto;">
            <h2 style="color:var(--accent-primary)">📢 定例報告会 (Quarter Review)</h2>
            <p>3ヶ月が経過しました。クライアントから質問が来ています。</p>
            
            <div class="chat-bubble ai" style="margin: 1.5rem 0; font-size:1.1rem; background:rgba(255,255,255,0.15);">
                ${c.question}
            </div>
            
            ${!isDone ? `
                <textarea id="challenge-input" class="challenge-input" placeholder="回答を入力してください..."></textarea>
                <button id="challenge-submit-btn" class="btn-primary" style="width:100%" onclick="submitChallengeAnswer()">回答する</button>
            ` : `
                <div style="background:rgba(0,0,0,0.3); padding:1rem; border-radius:8px; margin-bottom:1rem; text-align:left;">
                    <div style="font-size:0.8rem; color:#888;">あなたの回答</div>
                    <div>${c.answer}</div>
                </div>
                <div style="border-left: 4px solid ${c.score >= 7 ? 'var(--accent-primary)' : 'var(--accent-danger)'}; padding-left:1rem; text-align:left;">
                    <h3>クライアントの反応 (スコア: ${c.score}/10)</h3>
                    <p>${c.feedback}</p>
                    ${c.score >= 8 ? '<p style="color:#4caf50; font-weight:bold;">✨ 信頼を獲得し、来月の予算が増額されました！</p>' : ''}
                    ${c.score <= 3 ? '<p style="color:#f44336; font-weight:bold;">⚠️ 信頼を損ないました...予算は現状維持です。</p>' : ''}
                </div>
                <button class="btn-primary" style="width:100%; margin-top:2rem;" onclick="nextMonth()">次の月へ</button>
            `}
        </div>
    `;
}

function renderActionPanel() {
    const totalAllocated = Object.values(state.allocation).reduce((a, b) => a + b, 0);
    const remaining = state.brief.budget - totalAllocated;
    const isRunning = state.view === 'RUNNING';
    const isResult = state.view === 'RESULT';
    const disabled = isRunning || isResult;

    let feedbackMsg = "計算中...";
    if (isResult) {
        if (state.results.total.spend < state.brief.budget * 0.8) feedbackMsg = "予算未消化です。";
        else if (state.results.total.cpa > state.brief.targetCPA * 1.2) feedbackMsg = "CPA高騰中。";
        else feedbackMsg = "良好な成果です。";
    }

    return `
        <div>
            <div class="glass-panel">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h2 style="margin-top: 0">Planning</h2>
                    <div class="info-icon" onclick="setModal('CHANNEL_INFO')" title="媒体情報">?</div>
                </div>
                <div style="margin-bottom: 1.5rem; display: flex; justify-content: space-between;"><strong>残り予算</strong><span id="remaining-budget" style="color: ${remaining < 0 ? 'var(--accent-danger)' : 'white'}">${formatCurrency(remaining)}</span></div>
                <div style="display: flex; flex-direction: column; gap: 1rem; margin-bottom: 2rem;">
                    ${['google', 'meta', 'tiktok'].map(ch => `
                        <div>
                            <label style="text-transform: capitalize; font-size: 0.9rem; display: block; margin-bottom: 0.3rem;">${ch}</label>
                            <input type="number" value="${state.allocation[ch] || ''}" oninput="handleAllocationChange('${ch}', this.value)" ${disabled ? 'disabled' : ''} placeholder="0">
                        </div>
                    `).join('')}
                </div>
                <button id="execute-btn" class="btn-primary" style="width: 100%" onclick="handleRun()" ${disabled || remaining < 0 ? 'disabled' : ''}>${isRunning ? '実行中...' : '🚀 配信開始'}</button>
            </div>
            ${isResult ? `<div class="glass-panel" style="border-top: 4px solid var(--accent-primary)"><h3>結果分析</h3><p>${feedbackMsg}</p><button class="btn-primary" style="width: 100%; margin-top: 1rem;" onclick="nextMonth()">次の月へ</button></div>` : ''}
            ${renderChat()}
        </div>
    `;
}

function renderChat() {
    // Only show simple chat in Planning/Result
    const historyHtml = state.qaHistory.map(item => `
        <div class="chat-message ${item.q ? 'user' : ''}">
             ${item.q ? `<div class="chat-bubble user">${item.q}</div>` : ''}
        </div>
        <div class="chat-message ai">
             <div class="chat-bubble ai">${item.a}</div>
        </div>
    `).join('');

    return `
        <div class="glass-panel" style="margin-top: 1rem;">
            <h3 style="margin-top:0">クライアントへの質問 (AI)</h3>
            <div class="chat-container">
                ${historyHtml.length ? historyHtml : '<div style="color:var(--text-secondary); text-align:center;">質問を入力してください</div>'}
            </div>
            <div class="chat-input-area">
                <input type="text" id="chat-input" placeholder="この商材の強みは？" style="flex: 1; padding: 0.8rem; border-radius: 6px; border: 1px solid var(--border-color); background: rgba(0,0,0,0.3); color: white;">
                <button class="btn-primary" onclick="handleQuestionSubmit()">送信</button>
            </div>
        </div>
    `;
}

function render() {
    const app = document.getElementById('app');
    if (state.view === 'API_KEY') { app.innerHTML = renderApiKeyModal(); return; }
    if (state.view === 'LOADING') { app.innerHTML = renderLoading(); return; }
    if (state.view === 'BRIEF') { app.innerHTML = renderHeader() + renderBrief(); return; }
    if (state.view === 'CHALLENGE') { app.innerHTML = renderChallenge(); return; }

    app.innerHTML = `
        ${renderHeader()}
        ${renderModal()}
        <div class="grid-main">
            <div>${renderDashboard()}${state.view === 'RESULT' ? renderDetailedStats() : ''}</div>
            ${renderActionPanel()}
        </div>
    `;
}

function renderDashboard() {
    const { results, brief, view } = state;
    const spend = results ? results.total.spend : 0;
    const cpa = results ? results.total.cpa : 0;
    const roas = results ? results.total.roas : 0;
    const spendPercent = Math.min((spend / brief.budget) * 100, 100);
    const cpaColor = (results && cpa > brief.targetCPA) ? 'var(--accent-danger)' : 'var(--accent-secondary)';
    const roasColor = (results && roas < brief.minROAS) ? 'var(--accent-danger)' : 'var(--accent-secondary)';

    return `
        <div class="glass-panel">
            <h2 style="margin-top: 0">ダッシュボード</h2>
            <div class="grid-3" style="margin-bottom: 2rem;">
                <div class="stat-card">
                    <div class="stat-label">消化金額</div>
                    <div class="stat-value">${view === 'RESULT' ? formatCurrency(spend) : '---'}</div>
                    <div class="stat-label">予算: ${formatCurrency(brief.budget)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">CPA (目標: ${formatCurrency(brief.targetCPA)})</div>
                    <div class="stat-value" style="color: ${view === 'RESULT' ? cpaColor : 'white'}">${view === 'RESULT' ? formatCurrency(cpa) : '---'}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">ROAS (目標: ${brief.minROAS.toFixed(2)})</div>
                    <div class="stat-value" style="color: ${view === 'RESULT' ? roasColor : 'white'}">${view === 'RESULT' ? roas.toFixed(2) : '---'}</div>
                </div>
            </div>
            <div>
                <div style="display: flex; justify-content: space-between; font-size: 0.9rem; margin-bottom: 0.5rem;"><span>予算消化率</span><span>${Math.round(spendPercent)}%</span></div>
                <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${spendPercent}%"></div></div>
            </div>
        </div>
    `;
}

function renderDetailedStats() {
    if (!state.results) return '';
    const channels = state.results.channels;
    let rows = '';
    for (const [ch, data] of Object.entries(channels)) {
        if (!data) continue;
        rows += `
            <tr>
                <td style="text-transform: capitalize; padding: 0.8rem; border-bottom: 1px solid var(--glass-border)">${ch}</td>
                <td style="padding: 0.8rem; border-bottom: 1px solid var(--glass-border)">${formatCurrency(data.spend)}</td>
                <td style="padding: 0.8rem; border-bottom: 1px solid var(--glass-border)">${formatNum(data.impressions)}</td>
                <td style="padding: 0.8rem; border-bottom: 1px solid var(--glass-border)">${formatNum(data.clicks)} (${formatPercent(data.ctr)})</td>
                <td style="padding: 0.8rem; border-bottom: 1px solid var(--glass-border)">${formatNum(data.conversions)} (${formatPercent(data.cvr)})</td>
                <td style="padding: 0.8rem; border-bottom: 1px solid var(--glass-border); font-weight:bold">${formatCurrency(data.cpa)}</td>
                <td style="padding: 0.8rem; border-bottom: 1px solid var(--glass-border)">${data.roas.toFixed(2)}</td>
            </tr>
        `;
    }
    return `
        <div class="glass-panel" style="margin-top: 2rem;">
            <h3>詳細配信レポート</h3>
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem; text-align: right;">
                    <thead>
                        <tr style="color: var(--text-secondary); text-align: right;">
                            <th style="text-align: left; padding: 0.5rem;">媒体</th><th style="padding: 0.5rem;">コスト</th><th style="padding: 0.5rem;">Imp</th><th style="padding: 0.5rem;">Click (CTR)</th><th style="padding: 0.5rem;">CV (CVR)</th><th style="padding: 0.5rem;">CPA</th><th style="padding: 0.5rem;">ROAS</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

// Init
if (state.apiKey) {
    generateBriefWithGemini();
} else {
    render();
}
