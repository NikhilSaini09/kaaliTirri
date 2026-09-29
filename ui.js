window.addEventListener('beforeunload', (event) => {
    if (gameState.phase !== 'LOBBY' || gameState.players.length > 1) {
        event.preventDefault();
        event.returnValue = '';
    }
});

function switchView(viewId) {
    document.querySelectorAll('.view-container').forEach(el => el.style.display = 'none');
    document.getElementById(viewId).style.display = 'flex';
}

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(freq, type, duration, vol) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}
function playCardSound() { playTone(250, 'triangle', 0.1, 0.4); } 
function playTurnSound() { playTone(600, 'sine', 0.3, 0.2); setTimeout(() => playTone(800, 'sine', 0.4, 0.2), 100); } 
function playTickSound() { playTone(800, 'square', 0.05, 0.05); } 

const PHASE_LABELS = {
    LOBBY: 'Lobby',
    BIDDING: 'Bidding',
    TRUMP_SELECTION: 'Choosing Trump',
    PLAYING: 'Playing',
    TRICK_EVALUATION: 'Evaluating Trick',
    GAMEOVER: 'Round Over'
};

function renderState() {
    if (gameState.phase === 'LOBBY') {
        switchView('view-lobby');
        renderLobby();
    } else {
        switchView('view-game');
        renderGameBoard();
    }
}

function renderLobby() {
    stopTimerBarLoop(); // otherwise a countdown started mid-hand keeps ticking (and beeping) in the background
    const lobbyDiv = document.getElementById('lobby-players');
    lobbyDiv.innerHTML = '';

    const excluded = new Set(gameState.excludedIds || []);
    const members = getLobbyMembers();

    members.forEach((member, index) => {
        const isGone = isDisconnected(member.id);
        const isOut = isGone || excluded.has(member.id);

        const row = document.createElement('div');
        row.className = 'lobby-player-row' + (isOut ? ' is-sitting-out' : '');

        const main = document.createElement('div');
        main.className = 'lobby-player-main';

        if (isHost) {
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.id = `seat-${member.id}`;
            check.name = `seat-${member.id}`;
            check.className = 'seat-check';
            check.checked = !isOut;
            check.disabled = isGone;
            check.setAttribute('aria-label', `${cleanPlayerName(member.name)} plays next game`);
            check.title = isGone ? 'Disconnected' : (isOut ? 'Click to let them play' : 'Click to make them a spectator');
            check.addEventListener('change', () => toggleSeat(member.id));
            main.appendChild(check);
        }

        const nameEl = document.createElement('span');
        nameEl.textContent = cleanPlayerName(member.name);
        main.appendChild(nameEl);

        if (member.id === myPeerId) {
            const you = document.createElement('span');
            you.className = 'you-tag';
            you.textContent = 'YOU';
            main.appendChild(you);
        }
        if (isGone) {
            const tag = document.createElement('span');
            tag.className = 'disconnected-tag';
            tag.textContent = 'DISCONNECTED';
            main.appendChild(tag);
        } else if (isOut) {
            const tag = document.createElement('span');
            tag.className = 'spectating-tag';
            tag.textContent = 'SPECTATING';
            main.appendChild(tag);
        }
        row.appendChild(main);

        if (isHost) {
            const controls = document.createElement('div');
            controls.className = 'lobby-row-controls';

            const up = document.createElement('button');
            up.className = 'btn-wood move-btn';
            up.textContent = '\u25B2';
            up.setAttribute('aria-label', 'Move up');
            up.disabled = index === 0;
            up.addEventListener('click', () => moveMember(member.id, -1));

            const down = document.createElement('button');
            down.className = 'btn-wood move-btn';
            down.textContent = '\u25BC';
            down.setAttribute('aria-label', 'Move down');
            down.disabled = index === members.length - 1;
            down.addEventListener('click', () => moveMember(member.id, 1));

            controls.appendChild(up);
            controls.appendChild(down);

            if (member.id !== myPeerId) {
                const kick = document.createElement('button');
                kick.className = 'btn-danger';
                kick.style.cssText = 'padding: 5px 12px; font-size: 13px;';
                kick.textContent = 'Kick';
                kick.addEventListener('click', () => kickPlayer(member.id));
                controls.appendChild(kick);
            }
            row.appendChild(controls);
        }

        lobbyDiv.appendChild(row);
    });

    const goneCount = members.filter(m => isDisconnected(m.id)).length;
    const outCount = members.filter(m => !isDisconnected(m.id) && excluded.has(m.id)).length;
    const seatedCount = members.length - goneCount - outCount;

    const summary = document.getElementById('lobby-summary');
    summary.textContent = `${seatedCount} playing`
        + (outCount ? ` \u00b7 ${outCount} spectating` : '')
        + (goneCount ? ` \u00b7 ${goneCount} disconnected` : '');

    if (isHost) {
        document.getElementById('startGameBtn').style.display = seatedCount >= MIN_PLAYERS ? 'block' : 'none';
    }
}

let timerBarInterval = null;
let timerBarDeadline = null;
let lastTickSec = -1;

function startTimerBarLoop(deadline, totalMs, label) {
    const labelEl = document.getElementById('timer-bar-label');
    if (labelEl) labelEl.textContent = label || '';

    if (timerBarDeadline === deadline && timerBarInterval) return;
    timerBarDeadline = deadline;
    if (timerBarInterval) clearInterval(timerBarInterval);

    const wrap = document.getElementById('timer-bar-wrap');
    const fill = document.getElementById('timer-bar-fill');
    const text = document.getElementById('timer-bar-text');

    const tick = () => {
        const remainingMs = Math.max(0, deadline - Date.now());
        const remainingSec = Math.ceil(remainingMs / 1000);
        const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
        fill.style.width = `${pct}%`;
        text.textContent = `${remainingSec}s`;
        wrap.classList.toggle('urgent', remainingSec <= 10);
        
        if (remainingSec <= 5 && remainingSec > 0 && lastTickSec !== remainingSec) {
            playTickSound();
            lastTickSec = remainingSec;
        }

        if (remainingMs <= 0) {
            clearInterval(timerBarInterval);
            timerBarInterval = null;
        }
    };
    tick();
    timerBarInterval = setInterval(tick, 250);
}

function stopTimerBarLoop() {
    if (timerBarInterval) clearInterval(timerBarInterval);
    timerBarInterval = null;
    timerBarDeadline = null;
    lastTickSec = -1;
    document.getElementById('timer-bar-wrap').classList.remove('is-visible', 'urgent');
}

function cleanPlayerName(name) {
    return name.replace(' (Host)', ' (H)').replace(' (Spectator)', ' (S)');
}

// Player names are chosen by whoever joins the room and get interpolated into innerHTML
// in a few places below - escape them first so a name like "<img src=x onerror=...>"
// can't run script in everyone else's browser.
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

let previousTurnPlayerId = null;
let previousBoardLength = null;
let bidPanelWasOpen = false;
let bidAmountEditedByUser = false;
let hasAutoFocusedBidOnce = false;

function renderGameBoard() {
    const myArea = document.getElementById('my-area');
    const boardArea = document.getElementById('center-board');
    const oppArea = document.getElementById('opponents-area');
    const gameInfo = document.getElementById('game-info');
    const hostControls = document.getElementById('host-controls-wrapper');
    const scorecard = document.getElementById('scorecard-modal');
    const modalBtn = document.getElementById('modalBackToLobbyBtn');
    const actionOverlay = document.getElementById('action-overlay');
    const biddingPanel = document.getElementById('bidding-panel');
    const trumpPanel = document.getElementById('trump-panel');
    const teamCardsContainer = document.getElementById('team-cards-container');
    const timerWrap = document.getElementById('timer-bar-wrap');
    const foldBanner = document.getElementById('fold-banner');

    myArea.innerHTML = ''; boardArea.innerHTML = ''; oppArea.innerHTML = '';
    document.getElementById('phase-display').innerHTML = `Phase: <span class="phase-label">${PHASE_LABELS[gameState.phase] || gameState.phase}</span>`;
    hostControls.style.display = isHost ? 'block' : 'none';

    const pauseOverlay = document.getElementById('pause-overlay');
    pauseOverlay.style.display = gameState.isPaused ? 'flex' : 'none';
    const resumeBtn = document.getElementById('resumeFromOverlayBtn');
    if (resumeBtn) resumeBtn.style.display = isHost ? 'inline-block' : 'none';
    const pauseMenuBtn = document.getElementById('hostPauseBtn');
    if (pauseMenuBtn) pauseMenuBtn.textContent = gameState.isPaused ? '▶ Resume Game' : '⏸ Pause Game';

    const activeTurnPlayer = (gameState.phase === 'PLAYING' && gameState.players.length > 0)
        ? gameState.players[gameState.turnIndex]
        : null;

    if (activeTurnPlayer && activeTurnPlayer.id === myPeerId && previousTurnPlayerId !== myPeerId && !gameState.isPaused) {
        playTurnSound();
    }
    previousTurnPlayerId = activeTurnPlayer ? activeTurnPlayer.id : null;

    // Everyone hears a card land, not just whoever played it - detected from the board
    // growing rather than from the local click, so it fires the same way for all clients.
    if (gameState.phase === 'PLAYING' || gameState.phase === 'TRICK_EVALUATION') {
        if (previousBoardLength !== null && gameState.board.length > previousBoardLength && !gameState.isPaused) {
            playCardSound();
        }
        previousBoardLength = gameState.board.length;
    } else {
        previousBoardLength = null;
    }

    if (gameState.phase === 'BIDDING' && gameState.biddingDeadline) {
        timerWrap.classList.add('is-visible');
        startTimerBarLoop(gameState.biddingDeadline, BIDDING_TIME_MS, 'Bidding');
    } else if (gameState.phase === 'PLAYING' && gameState.turnDeadline) {
        timerWrap.classList.add('is-visible');
        const turnName = activeTurnPlayer ? cleanPlayerName(activeTurnPlayer.name) : '';
        const isMe = activeTurnPlayer && activeTurnPlayer.id === myPeerId;
        startTimerBarLoop(gameState.turnDeadline, TURN_TIME_MS, isMe ? 'Your turn' : `${turnName}'s turn`);
    } else {
        stopTimerBarLoop();
    }

    const myIndex = gameState.players.findIndex(p => p.id === myPeerId);
    const n = gameState.players.length;
    let opponents;
    if (myIndex !== -1) {
        opponents = [];
        for (let i = 1; i < n; i++) opponents.push(gameState.players[(myIndex + i) % n]);
    } else {
        opponents = gameState.players.slice();
    }

    const isMobile = window.innerWidth <= 860;
    oppArea.classList.toggle('mobile-row', isMobile);
    const totalOpp = opponents.length;
    const dense = totalOpp >= 5;
    boardArea.classList.toggle('dense-table', gameState.players.length >= 6);

    const SEAT_SPAN = 240, SEAT_START = 150;
    const seatAngle = {};
    opponents.forEach((player, index) => {
        seatAngle[player.id] = (SEAT_START + (index + 0.5) * SEAT_SPAN / totalOpp) * Math.PI / 180;
    });

    const tableWrapperEl = document.getElementById('table-wrapper');
    const tRect = tableWrapperEl.getBoundingClientRect();
    const tW = tRect.width || 380;
    const headerBottom = Math.max(
        document.getElementById('game-header').getBoundingClientRect().bottom,
        document.getElementById('status-stack').getBoundingClientRect().bottom
    );
    const halfW = dense ? 62 : 72, halfH = dense ? 54 : 62;

    function getSeatOffsetPct(index, total) {
        if (total === 1) return { left: 50, top: -38 };
        if (total === 2) return [{ left: -40, top: 50 }, { left: 140, top: 50 }][index];
        if (total === 3) return [{ left: -40, top: 56 }, { left: 50, top: -38 }, { left: 140, top: 56 }][index];
        const maxRxPx = window.innerWidth / 2 - halfW - 8;
        const maxRyPx = (tRect.top + tW / 2) - headerBottom - halfH - 8;
        const rxPx = Math.max(tW * 0.62, Math.min(tW * 1.0, maxRxPx));
        const ryPx = Math.max(tW * 0.6, Math.min(tW * 0.82, maxRyPx));
        const ang = seatAngle[opponents[index].id];
        return { left: 50 + Math.cos(ang) * rxPx / tW * 100, top: 50 + Math.sin(ang) * ryPx / tW * 100 };
    }
    function clampSeat(pos) {
        const x = tRect.left + pos.left / 100 * tW;
        const y = tRect.top + pos.top / 100 * tW;
        const cx = Math.min(Math.max(x, halfW + 6), window.innerWidth - halfW - 6);
        const cy = Math.max(y, headerBottom + halfH + 6);
        return { left: (cx - tRect.left) / tW * 100, top: (cy - tRect.top) / tW * 100 };
    }
    const seatPos = {};
    if (!isMobile) {
        opponents.forEach((player, index) => {
            seatPos[player.id] = clampSeat(getSeatOffsetPct(index, totalOpp));
        });
    }

    // 1. Center Board
    const winningCard = getCurrentWinningCard(gameState.board, gameState.trumpSuit);
    gameState.board.forEach((card) => {
        const cardEl = createCardElement(card, false);
        cardEl.classList.add('played-card');
        if (winningCard && card.id === winningCard.id) cardEl.classList.add('is-winning-card');
        const rotation = (Math.random() * 12 - 6);
        cardEl.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;

        const CARD_R = isMobile ? 32 : 30;
        let leftPct = 50, topPct = 50;
        if (card.playedBy === myPeerId) {
            leftPct = 50; topPct = 50 + CARD_R;
        } else if (seatAngle[card.playedBy] !== undefined) {
            const ang = seatAngle[card.playedBy];
            leftPct = 50 + Math.cos(ang) * CARD_R;
            topPct = 50 + Math.sin(ang) * CARD_R;
        }
        cardEl.style.left = `${leftPct}%`;
        cardEl.style.top = `${topPct}%`;
        boardArea.appendChild(cardEl);
    });

    // 2. Opponents
    opponents.forEach((player) => {
        const oppDiv = document.createElement('div');
        oppDiv.className = 'opponent-container' + (isMobile ? ' compact' : '') + (dense ? ' dense' : '');

        const isActiveTurn = activeTurnPlayer && activeTurnPlayer.id === player.id;
        const showFoldState = (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION');
        const isFolded = showFoldState && !!player.hasFolded;
        if (isActiveTurn) oppDiv.classList.add('is-active-turn');
        if (isFolded) oppDiv.classList.add('is-folded');

        if (!isMobile) {
            const pos = seatPos[player.id];
            oppDiv.style.left = `${pos.left}%`;
            oppDiv.style.top = `${pos.top}%`;
            oppDiv.style.transform = 'translate(-50%, -50%)';
        }

        let teamIcon = player.team === 'BIDDER_TEAM' ? '🔥 ' : (player.team === 'DEFENDER_TEAM' ? '🛡️ ' : '');
        const cleanName = cleanPlayerName(player.name);

        let pileHtml = '';
        if (player.wonCards && player.wonCards.length > 0) {
            pileHtml = isMobile
                ? `<div class="won-pile-btn" title="Click to view won cards"><span>${player.wonCards.length}</span></div>`
                : // <div class="card face-down mini-card"></div>
                ` <div class="won-pile-btn" title="Click to view won cards">
                    <span>${player.wonCards.length}</span>
                </div>
            `;
        }

        const fanHtml = isMobile ? '' :
            `<div class="hand-fan">${'<div class="card face-down mini-card hand-fan-card"></div>'.repeat(Math.min(player.hand.length / 2 + 1, 5))}</div>`;

        oppDiv.innerHTML = `
            <span class="opp-name">${isActiveTurn ? '<span class="turn-dot"></span>' : ''}${teamIcon}${escapeHtml(cleanName)}</span>
            <span class="opp-meta">${player.hand.length} C &middot; ${player.points} Pts</span>
            ${fanHtml}
            ${isFolded ? '<span class="fold-tag">FOLDED</span>' : ''}
            ${pileHtml}
        `;

        const pileBtn = oppDiv.querySelector('.won-pile-btn');
        if (pileBtn) {
            pileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openWonCardsModal(player);
            });
        }

        oppArea.appendChild(oppDiv);
    });

    const tableZoneEl = document.querySelector('.table-zone');
    tableZoneEl.style.paddingTop = isMobile ? `${Math.max(84, oppArea.offsetHeight + 28)}px` : '';

    if (gameState.phase !== 'LOBBY') {
        gameInfo.style.display = 'inline-flex';
        if (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION') {
            document.getElementById('bid-info').innerHTML = `High Bid: <b>${gameState.highestBid.amount || '—'}</b> (${gameState.highestBid.playerName ? escapeHtml(cleanPlayerName(gameState.highestBid.playerName)) : 'None yet'})`;
            document.getElementById('trump-info').innerHTML = '';
        } else {
            document.getElementById('bid-info').innerHTML = `Target: <b>${gameState.highestBid.amount}</b> (${escapeHtml(cleanPlayerName(gameState.highestBid.playerName))})`;
            const trumpColor = (gameState.trumpSuit === '♥' || gameState.trumpSuit === '♦') ? 'red' : 'black';
            let trumpHtml = `Trump: <span class="trump-suit-display ${trumpColor}">${gameState.trumpSuit}</span>`;
            if (gameState.originalCalledCards && gameState.originalCalledCards.length > 0) {
                const partnerHtml = gameState.originalCalledCards.map(c => {
                    const suit = c.slice(-1);
                    const cls = (suit === '♥' || suit === '♦') ? 'red' : 'black';
                    return `<b class="${cls}">${c}</b>`;
                }).join(', ');
                trumpHtml += ` &middot; Partner: ${partnerHtml}`;
            }
            document.getElementById('trump-info').innerHTML = trumpHtml;
        }
    }

    // 3. Local Player
    const me = gameState.players.find(p => p.id === myPeerId);
    if (me) {
        const isMyTurn = activeTurnPlayer && activeTurnPlayer.id === me.id;
        const statusRow = document.createElement('div');
        statusRow.className = 'my-status-row';
        myArea.appendChild(statusRow);
        
        if (isMyTurn) {
            const badge = document.createElement('div');
            badge.className = 'your-turn-badge';
            badge.innerHTML = '<span class="turn-dot"></span> Your Turn';
            statusRow.appendChild(badge);
        }

        me.hand.forEach((card, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'my-card-wrapper';
            wrapper.style.zIndex = index;

            const playable = isCardPlayable(myPeerId, card);
            const cardEl = createCardElement(card, true, playable);
            if (playable) cardEl.addEventListener('click', () => requestPlayCard(card));

            wrapper.appendChild(cardEl);
            myArea.appendChild(wrapper);
        });

        const cardWrappers = myArea.querySelectorAll('.my-card-wrapper');
        if (cardWrappers.length > 0) {
            const cardCount = cardWrappers.length;
            const gap = 8;
            const naturalWidth = window.innerWidth <= 640 ? 46 : 65;
            const minWidth = window.innerWidth <= 640 ? 30 : 40;
            const availWidth = myArea.clientWidth - 44;
            let cardW = Math.floor((availWidth - (cardCount - 1) * gap) / cardCount);
            cardW = Math.max(minWidth, Math.min(naturalWidth, cardW));
            const cardH = Math.round(cardW * 1.42);
            const rankSize = Math.max(11, Math.round(cardW * 0.30));
            const suitSize = Math.max(12, Math.round(cardW * 0.34));

            cardWrappers.forEach(wrapper => {
                wrapper.style.margin = `0 ${gap / 2}px 6px`;
                const cardEl = wrapper.querySelector('.card');
                if (!cardEl) return;
                cardEl.style.width = `${cardW}px`;
                cardEl.style.height = `${cardH}px`;
                cardEl.style.fontSize = `${rankSize}px`;
                    const suitEl = cardEl.querySelector('.card-suit');
                    if (suitEl) suitEl.style.fontSize = `${suitSize}px`;
            });
        }

        if (me.wonCards && me.wonCards.length > 0) {
            const myPileDiv = document.createElement('div');
            myPileDiv.className = 'my-won-pile';
            myPileDiv.title = "Click to view your won cards";
                 // <div class="card face-down mini-card"></div>
            myPileDiv.innerHTML = `
                <span>${me.wonCards.length} (${me.points} pts)</span>
            `;
            myPileDiv.addEventListener('click', () => openWonCardsModal(me));
            statusRow.appendChild(myPileDiv);
        }

        if (me.hasFolded && (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION')) {
        foldBanner.textContent = "You folded — waiting for the rest of the table";
            foldBanner.style.display = 'block';
        } else {
            foldBanner.style.display = 'none';
        }

        let showOverlay = false;
        biddingPanel.style.display = 'none';
        trumpPanel.style.display = 'none';

        if (gameState.phase === 'BIDDING' && !me.hasFolded) {
            showOverlay = true;
            biddingPanel.style.display = 'flex';

            // setTimeout(() => document.getElementById('bidAmount').focus(), 100);
            const minBid = Math.max(MIN_BID, gameState.highestBid.amount + 5);
            const bidInput = document.getElementById('bidAmount');
            bidInput.min = minBid;
            bidInput.max = MAX_BID;
            bidInput.placeholder = `${minBid}\u2013${MAX_BID}`;

            if (!bidPanelWasOpen) {
                // A fresh chance to bid (panel just appeared) - give it a sensible default.
                // Re-broadcasts while it's already open (someone else bidding/folding)
                // must NOT touch the value again, or typing gets wiped out mid-keystroke.
                bidInput.value = minBid;
                bidAmountEditedByUser = false;
                if (!hasAutoFocusedBidOnce && window.innerWidth > 860) {
                    bidInput.focus();
                    bidInput.select();
                    hasAutoFocusedBidOnce = true;
                }
            } else if (!bidAmountEditedByUser) {
                bidInput.value = minBid;
            }
            bidPanelWasOpen = true;
        }
        else {
            bidPanelWasOpen = false;
            if (gameState.phase === 'TRUMP_SELECTION' && gameState.highestBid.playerId === myPeerId) {
                showOverlay = true;
                trumpPanel.style.display = 'flex';

                teamCardsContainer.innerHTML = '';
                let allowedCards = Math.floor((gameState.players.length - 2) / 2);
                for (let i = 0; i < allowedCards; i++) {
                    const selectorDiv = document.createElement('div');

                    const rankSelect = document.createElement('select');
                    rankSelect.className = 'team-rank-select';
                    rankSelect.id = `team-rank-${i}`;
                    rankSelect.name = `team-rank-${i}`;
                    rankSelect.setAttribute('aria-label', `Partner card ${i + 1} rank`);
                    values.forEach(v => rankSelect.appendChild(new Option(v, v)));

                    const suitSelect = document.createElement('select');
                    suitSelect.className = 'team-suit-select';
                    suitSelect.id = `team-suit-${i}`;
                    suitSelect.name = `team-suit-${i}`;
                    suitSelect.setAttribute('aria-label', `Partner card ${i + 1} suit`);
                    suits.forEach(s => suitSelect.appendChild(new Option(s, s)));

                    selectorDiv.appendChild(rankSelect); selectorDiv.appendChild(suitSelect);
                    teamCardsContainer.appendChild(selectorDiv);
                }
            }
        }

        actionOverlay.style.display = showOverlay ? 'flex' : 'none';
        actionOverlay.classList.toggle('no-dim', gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION');
    }

    // 4. Game Over Modal
    if (gameState.phase === 'GAMEOVER') {
        scorecard.style.display = 'block';
        modalBtn.style.display = isHost ? 'block' : 'none';

        let bTeamHtml = ''; let bTotal = 0;
        let dTeamHtml = ''; let dTotal = 0;

        gameState.players.forEach(p => {
            const clean = escapeHtml(cleanPlayerName(p.name));
            const stats = gameStats[clean.replace(" (H)", "")] || { wins: 0, gamesPlayed: 0, winRate: '0.0%' };
            const statLine = `<span style="font-size: 11px; opacity: 0.8; display: block;">Career: ${stats.wins}W / ${stats.gamesPlayed - stats.wins}L (${stats.winRate})</span>`;
            
            if (p.team === 'BIDDER_TEAM') {
                bTeamHtml += `<div style="margin-bottom: 6px;">${clean}: <b>${p.points} pts</b>${statLine}</div>`;
                bTotal += p.points;
            } else {
                dTeamHtml += `<div style="margin-bottom: 6px;">${clean}: <b>${p.points} pts</b>${statLine}</div>`;
                dTotal += p.points;
            }

            // if (p.team === 'BIDDER_TEAM') {
            //     bTeamHtml += `<div>${cleanPlayerName(p.name)}: ${p.points}</div>`;
            //     bTotal += p.points;
            // } else {
            //     dTeamHtml += `<div>${cleanPlayerName(p.name)}: ${p.points}</div>`;
            //     dTotal += p.points;
            // }
        });

        document.getElementById('bidder-stats').innerHTML = bTeamHtml;
        document.getElementById('defender-stats').innerHTML = dTeamHtml;
        document.getElementById('bidder-total').textContent = bTotal;
        document.getElementById('defender-total').textContent = dTotal;
        document.getElementById('bid-target').textContent = gameState.highestBid.amount;

        const won = bTotal >= gameState.highestBid.amount;
        document.getElementById('score-title').textContent = won ? "Bidder Team WON!" : "Defender Team WON!";
        document.getElementById('score-title').style.color = won ? "#f44336" : "#4CAF50";
    } else {
        scorecard.style.display = 'none';
    }
}

function getCurrentWinningCard(board, trumpSuit) {
    if (!board || board.length === 0) return null;
    const leadSuit = board[0].suit;
    let winning = board[0];
    for (let i = 1; i < board.length; i++) {
        const card = board[i];
        const isTrump = card.suit === trumpSuit;
        const winIsTrump = winning.suit === trumpSuit;
        if (isTrump && !winIsTrump) {
            winning = card;
        } else if ((isTrump && winIsTrump) || (!isTrump && !winIsTrump && card.suit === leadSuit)) {
            if (getCardRank(card) > getCardRank(winning)) winning = card;
        }
    }
    return winning;
}

function createCardElement(card, isClickable, isPlayable = true) {
    const cardEl = document.createElement('div');
    cardEl.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
    cardEl.innerHTML = `<span class="card-rank">${card.value}</span><span class="card-suit">${card.suit}</span>`;

    if (isClickable && !isPlayable) {
        cardEl.style.opacity = '0.5';
        cardEl.style.cursor = 'not-allowed';
    }
    return cardEl;
}

function requestPlayCard(card) {
    if (!isCardPlayable(myPeerId, card)) { alert("You cannot play this card."); return; }
    if (isHost) { handlePlayCard(myPeerId, card); broadcastState(); }
    else if (hostConnection) hostConnection.send({ type: 'ACTION_PLAY_CARD', card: card });
}

function normalizeName(name) {
    if (!name) return "";
    return name.replace(/\s*\((Host|H|Spectator|S)\)\s*/gi, '').trim();
}

function saveGame() {
    const payload = {
        gameState: gameState,
        gameStats: gameStats,
        playerData: playerData
    };

    const dataStr = JSON.stringify(payload, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', `kaali_tirri_save_${Date.now()}.json`);
    linkElement.click();
}

function loadGame(event) {
    if (!isHost) {
        alert("Only the room host can load save files.");
        return;
    }

    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parsed = JSON.parse(e.target.result);

            if (parsed.gameState) {
                playerData = parsed.playerData || [];
                
                let allCurrentUsers = [];
                gameState.players.forEach(p => allCurrentUsers.push({ id: p.id, name: p.name }));
                (gameState.spectators || []).forEach(s => allCurrentUsers.push({ id: s.id, name: s.name }));
                
                let uniqueUsers = Array.from(new Map(allCurrentUsers.map(item => [item.id, item])).values());
                let currentPool = [...uniqueUsers];
                let leftoverSpectators = [];
                let idMap = {};
                
                let newPlayers = new Array(parsed.gameState.players.length).fill(null);

                // PASS 1: Robust normalized name matching
                parsed.gameState.players.forEach((savedPlayer, index) => {
                    const matchIndex = currentPool.findIndex(p => normalizeName(p.name) === normalizeName(savedPlayer.name));
                    if (matchIndex !== -1) {
                        const matchedConn = currentPool.splice(matchIndex, 1)[0];
                        idMap[savedPlayer.id] = matchedConn.id;
                        savedPlayer.id = matchedConn.id;
                        newPlayers[index] = savedPlayer;
                    }
                });

                // PASS 2: Map unassigned seats
                parsed.gameState.players.forEach((savedPlayer, index) => {
                    if (!newPlayers[index]) {
                        if (currentPool.length > 0) {
                            const matchedConn = currentPool.shift();
                            idMap[savedPlayer.id] = matchedConn.id;
                            savedPlayer.id = matchedConn.id;
                            savedPlayer.name = matchedConn.name;
                            newPlayers[index] = savedPlayer;
                        }
                    }
                });

                newPlayers = newPlayers.filter(p => p !== null);

                // PASS 3: Remaining connected users become spectators
                currentPool.forEach(conn => {
                    leftoverSpectators.push({ id: conn.id, name: conn.name + " (Spectator)" });
                });

                parsed.gameState.players = newPlayers;
                parsed.gameState.spectators = leftoverSpectators;

                if (parsed.gameState.lobbyOrder) {
                    let newLobbyOrder = [];
                    parsed.gameState.lobbyOrder.forEach(oldId => {
                        if (idMap[oldId]) newLobbyOrder.push(idMap[oldId]);
                    });
                    leftoverSpectators.forEach(s => newLobbyOrder.push(s.id));
                    parsed.gameState.lobbyOrder = newLobbyOrder;
                }

                if (parsed.gameState.highestBid && idMap[parsed.gameState.highestBid.playerId]) {
                    parsed.gameState.highestBid.playerId = idMap[parsed.gameState.highestBid.playerId];
                    const bidder = newPlayers.find(p => p.id === parsed.gameState.highestBid.playerId);
                    if (bidder) parsed.gameState.highestBid.playerName = bidder.name;
                } else if (parsed.gameState.highestBid) {
                    parsed.gameState.highestBid.playerId = null;
                }

                parsed.gameState.board.forEach(card => {
                    if (idMap[card.playedBy]) card.playedBy = idMap[card.playedBy];
                });

                if (parsed.gameState.turnIndex >= newPlayers.length) {
                    parsed.gameState.turnIndex = 0; 
                }

                // Reset and Auto-Pause
                parsed.gameState.isPaused = true;
                parsed.gameState.pausedRemaining = 30000;
                parsed.gameState.biddingDeadline = null;
                parsed.gameState.turnDeadline = null;

                gameState = parsed.gameState;
                gameStats = parsed.gameStats || {};

                broadcastState();
            } else {
                throw new Error("Invalid structure");
            }
        } catch(err) {
            alert("Failed to parse the save file.");
            console.error(err);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function openWonCardsModal(player) {
    const modal = document.getElementById('won-cards-modal');
    const title = document.getElementById('won-cards-title');
    const list = document.getElementById('won-cards-list');

    const cleanName = cleanPlayerName(player.name);
    title.textContent = `${cleanName}'s Won Cards (${player.wonCards ? player.wonCards.length : 0} cards, ${player.points} pts)`;
    list.innerHTML = '';

    if (!player.wonCards || player.wonCards.length === 0) {
        list.innerHTML = '<p style="color: #aaa; margin: auto;">No tricks won yet.</p>';
    } else {
        player.wonCards.forEach(card => {
            const cardEl = createCardElement(card, false);
            cardEl.style.cursor = 'default';
            list.appendChild(cardEl);
        });
    }
    modal.style.display = 'block';
    document.getElementById('won-cards-modal-backdrop').style.display = 'block';
}

// UI Bindings
document.getElementById('startGameBtn').addEventListener('click', () => {
    if (!isHost) return;
    if (!applySeatSelection()) {
        alert(`Tick at least ${MIN_PLAYERS} players to start.`);
        return;
    }
    startDeal();
    broadcastState();
});

document.getElementById('modalBackToLobbyBtn').addEventListener('click', () => {
    if (isHost) {
        gameState.phase = 'LOBBY';

        gameState.excludedIds = (gameState.spectators || []).map(sp => sp.id);

        gameState.players.forEach(p => {
            p.hand = [];
            p.wonCards = [];
            p.points = 0;
            p.currentBid = 0;
            p.hasFolded = false;
            p.team = 'UNKNOWN';
        });

        gameState.board = [];
        gameState.highestBid = { playerId: null, amount: 0, playerName: "" };
        gameState.trumpSuit = null;
        gameState.calledCards = [];
        gameState.originalCalledCards = [];
        gameState.biddingDeadline = null;
        gameState.turnDeadline = null;
        gameState.isPaused = false;
        gameState.pausedRemaining = null;

        broadcastState();
    }
});

document.getElementById('bidAmount').addEventListener('input', () => {
    bidAmountEditedByUser = true;
});

document.getElementById('submitBidBtn').addEventListener('click', () => {
    const bidInput = document.getElementById('bidAmount');
    const bid = bidInput.value;

    if (!bid || bid === "") return;

    if (isHost) { 
        const res = handlePlaceBid(myPeerId, bid); 
        if (res && res.error) {
            alert(res.error);
        } else {
            bidAmountEditedByUser = false;
            broadcastState(); 
        }
    }
    else if (hostConnection) {
        bidAmountEditedByUser = false;
        hostConnection.send({ type: 'ACTION_PLACE_BID', amount: bid });
    }
});

document.getElementById('foldBtn').addEventListener('click', () => {
    if (gameState.highestBid.playerId === myPeerId) { alert("You have the highest bid, you cannot fold!"); return; }
    if (isHost) { handleFold(myPeerId); broadcastState(); }
    else if (hostConnection) hostConnection.send({ type: 'ACTION_FOLD' });
});

document.getElementById('setTrumpBtn').addEventListener('click', () => {
    const suit = document.getElementById('trumpSuitSelect').value;
    const ranks = document.querySelectorAll('.team-rank-select');
    const suits = document.querySelectorAll('.team-suit-select');
    let chosenCards = [];

    for (let i = 0; i < ranks.length; i++) {
        chosenCards.push(`${ranks[i].value}${suits[i].value}`);
    }

    if (isHost) { handleSetTrump(myPeerId, suit, chosenCards); broadcastState(); }
    else if (hostConnection) hostConnection.send({ type: 'ACTION_SET_TRUMP', suit: suit, cards: chosenCards });
});

function closeWonCardsModal() {
    document.getElementById('won-cards-modal').style.display = 'none';
    document.getElementById('won-cards-modal-backdrop').style.display = 'none';
}
document.getElementById('closeWonCardsBtn')?.addEventListener('click', closeWonCardsModal);
document.getElementById('won-cards-modal-backdrop')?.addEventListener('click', closeWonCardsModal);

function closeHostMenu() {
    const menu = document.getElementById('host-dropdown');
    if (menu) menu.style.display = 'none';
}

document.getElementById('hostMenuToggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('host-dropdown');
    const currentDisplay = window.getComputedStyle(menu).display;
    menu.style.display = (currentDisplay === 'none') ? 'flex' : 'none';
});

document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('host-controls-wrapper');
    if (wrapper && !wrapper.contains(e.target)) closeHostMenu();
});

document.getElementById('hostReshuffleBtn')?.addEventListener('click', () => {
    if(isHost) { startDeal(); broadcastState(); }
    closeHostMenu();
});
document.getElementById('hostPauseBtn')?.addEventListener('click', () => {
    if (isHost) { togglePause(); }
    closeHostMenu();
});
document.getElementById('resumeFromOverlayBtn')?.addEventListener('click', () => {
    if (isHost) { togglePause(); }
});
document.getElementById('hostBackToLobbyBtn')?.addEventListener('click', () => {
    if(isHost) { document.getElementById('modalBackToLobbyBtn').click(); }
    closeHostMenu();
});

document.getElementById('saveBtn')?.addEventListener('click', saveGame);
document.getElementById('loadInput')?.addEventListener('change', loadGame);
document.getElementById('hostSaveBtn')?.addEventListener('click', () => { saveGame(); closeHostMenu(); });
document.getElementById('hostLoadInput')?.addEventListener('change', (e) => { loadGame(e); closeHostMenu(); });

let lastIsMobile = window.innerWidth <= 860;
window.addEventListener('resize', () => {
    const nowMobile = window.innerWidth <= 860;
    if (nowMobile !== lastIsMobile) {
        lastIsMobile = nowMobile;
        if (gameState.phase !== 'LOBBY' && document.getElementById('view-game').style.display !== 'none') renderGameBoard();
    }
});
