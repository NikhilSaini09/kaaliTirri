window.addEventListener('beforeunload', (event) => {
    if (gameState.phase !== 'LOBBY' || gameState.players.length > 1) {
        event.preventDefault();
        event.returnValue = ''; // Standard trigger for modern browsers
    }
});

function switchView(viewId) {
    document.querySelectorAll('.view-container').forEach(el => el.style.display = 'none');
    document.getElementById(viewId).style.display = 'flex';
}

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
    const lobbyDiv = document.getElementById('lobby-players');
    lobbyDiv.innerHTML = '';

    gameState.players.forEach(player => {
        const pDiv = document.createElement('div');
        pDiv.className = 'lobby-player-row';

        let html = `<span>${player.name}${player.id === myPeerId ? '<span class="you-tag">YOU</span>' : ''}</span>`;
        if (isHost && player.id !== myPeerId) {
            html += `<button class="btn-danger" onclick="kickPlayer('${player.id}')" style="padding: 5px 12px; font-size: 13px;">Kick</button>`;
        }

        pDiv.innerHTML = html;
        lobbyDiv.appendChild(pDiv);
    });

    if (isHost) {
        document.getElementById('startGameBtn').style.display = gameState.players.length >= 2 ? 'block' : 'none';
    }
}

let timerBarInterval = null;
let timerBarDeadline = null;

function startTimerBarLoop(deadline) {
    if (timerBarDeadline === deadline && timerBarInterval) return; // already tracking this window
    timerBarDeadline = deadline;
    if (timerBarInterval) clearInterval(timerBarInterval);

    const wrap = document.getElementById('timer-bar-wrap');
    const fill = document.getElementById('timer-bar-fill');
    const text = document.getElementById('timer-bar-text');

    const tick = () => {
        const remainingMs = Math.max(0, deadline - Date.now());
        const remainingSec = Math.ceil(remainingMs / 1000);
        const pct = Math.max(0, Math.min(100, (remainingMs / BIDDING_TIME_MS) * 100));
        fill.style.width = `${pct}%`;
        text.textContent = `${remainingSec}s`;
        wrap.classList.toggle('urgent', remainingSec <= 10);
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
    document.getElementById('timer-bar-wrap').classList.remove('is-visible', 'urgent');
}

function cleanPlayerName(name) {
    return name.replace(' (Host)', '').replace(' (Spectator)', '');
}

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

    // Whose turn is it right now (only meaningful once cards are being played)?
    const activeTurnPlayer = (gameState.phase === 'PLAYING' && gameState.players.length > 0)
        ? gameState.players[gameState.turnIndex]
        : null;

    // Bidding countdown
    if (gameState.phase === 'BIDDING' && gameState.biddingDeadline) {
        timerWrap.classList.add('is-visible');
        startTimerBarLoop(gameState.biddingDeadline);
    } else {
        stopTimerBarLoop();
    }

    // 1. Center Board (Played Cards)
    gameState.board.forEach((card, index) => {
        const cardEl = createCardElement(card, false);
        cardEl.classList.add('played-card');
        const rotation = (Math.random() * 20 - 10) + (index * 15); // Random spin
        cardEl.style.transform = `rotate(${rotation}deg)`;
        boardArea.appendChild(cardEl);
    });

    // 2. Opponents (Radial Distribution)
    const opponents = gameState.players.filter(p => p.id !== myPeerId);
    const angleStep = Math.PI / (opponents.length + 1);

    opponents.forEach((player, index) => {
        const oppDiv = document.createElement('div');
        oppDiv.className = 'opponent-container';
        oppDiv.style.pointerEvents = 'auto';

        const isActiveTurn = activeTurnPlayer && activeTurnPlayer.id === player.id;
        const isFolded = !!player.hasFolded;
        if (isActiveTurn) oppDiv.classList.add('is-active-turn');
        if (isFolded) oppDiv.classList.add('is-folded');

        let teamIcon = player.team === 'BIDDER_TEAM' ? '🔥' : (player.team === 'DEFENDER_TEAM' ? '🛡️' : '❓');
        const cleanName = cleanPlayerName(player.name);

        let pileHtml = '';
        if (player.wonCards && player.wonCards.length > 0) {
            pileHtml = `
                <div class="won-pile-btn" title="Click to view won cards">
                    <div class="card face-down mini-card"></div>
                    <span>${player.wonCards.length} won</span>
                </div>
            `;
        }

        oppDiv.innerHTML = `
            <span class="opp-name">${isActiveTurn ? '<span class="turn-dot"></span>' : ''}${teamIcon} ${cleanName}</span>
            <span class="opp-meta">${player.hand.length} 🃏 &middot; ${player.points} pts</span>
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

        // Calculate Position
        const angle = angleStep * (index + 1);
        const rx = 40;
        const ry = 30;
        oppDiv.style.left = `${50 - Math.cos(angle) * rx}%`;
        oppDiv.style.top = `${45 - Math.sin(angle) * ry}%`;
        oppDiv.style.transform = "translate(-50%, -50%)";

        oppArea.appendChild(oppDiv);
    });

    // 3. Local Player
    const me = gameState.players.find(p => p.id === myPeerId);
    if (me) {
        const isMyTurn = activeTurnPlayer && activeTurnPlayer.id === me.id;
        if (isMyTurn) {
            const badge = document.createElement('div');
            badge.className = 'your-turn-badge';
            badge.innerHTML = '<span class="turn-dot"></span> Your Turn';
            myArea.appendChild(badge);
        }

        me.hand.forEach((card, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'my-card-wrapper';

            // Apply layer classes based on index (e.g., wrap every 10 cards)
            const layerClass = `layer-${Math.floor(index / 10)}`;
            wrapper.classList.add(layerClass);

            // z-index ensures cards on the right overlay cards on the left
            wrapper.style.zIndex = index;

            const playable = isCardPlayable(myPeerId, card);
            const cardEl = createCardElement(card, true, playable);
            if (playable) cardEl.addEventListener('click', () => requestPlayCard(card));

            wrapper.appendChild(cardEl);
            myArea.appendChild(wrapper);
        });

        // Add clickable won pile for the local player if they have won cards
        if (me.wonCards && me.wonCards.length > 0) {
            const myPileDiv = document.createElement('div');
            myPileDiv.className = 'my-won-pile';
            myPileDiv.title = "Click to view your won cards";
            myPileDiv.innerHTML = `
                <div class="card face-down mini-card"></div>
                <span>${me.wonCards.length} won (${me.points} pts)</span>
            `;
            myPileDiv.addEventListener('click', () => openWonCardsModal(me));
            myArea.appendChild(myPileDiv);
        }

        // Fold status banner for the local player
        if (me.hasFolded && (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION')) {
            foldBanner.textContent = "You folded — waiting for the rest of the table";
            foldBanner.style.display = 'block';
        } else {
            foldBanner.style.display = 'none';
        }

        // Panels
        if (gameState.phase !== 'LOBBY') {
            gameInfo.style.display = 'block';
            if (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION') {
                document.getElementById('bid-info').innerHTML = `High Bid: <b>${gameState.highestBid.amount || '—'}</b> (${gameState.highestBid.playerName ? cleanPlayerName(gameState.highestBid.playerName) : 'None yet'})`;
                document.getElementById('trump-info').innerHTML = '';
            } else {
                document.getElementById('bid-info').innerHTML = `Target: <b>${gameState.highestBid.amount}</b> (${cleanPlayerName(gameState.highestBid.playerName)})`;
                document.getElementById('trump-info').innerHTML = `Cart: <b class="${gameState.trumpSuit === '♥' || gameState.trumpSuit === '♦' ? 'red' : 'black'}">${gameState.trumpSuit}</b>`;
            }
        }

        // 5. Action Overlay Routing
        let showOverlay = false;
        biddingPanel.style.display = 'none';
        trumpPanel.style.display = 'none';

        if (gameState.phase === 'BIDDING' && !me.hasFolded) {
            showOverlay = true;
            biddingPanel.style.display = 'flex';

            const minBid = Math.max(MIN_BID, gameState.highestBid.amount + 5);
            const bidInput = document.getElementById('bidAmount');
            bidInput.min = minBid;
            bidInput.max = MAX_BID;
            bidInput.placeholder = `${minBid}\u2013${MAX_BID}`;

            // Set default value automatically to make bidding faster
            bidInput.value = minBid;
        }
        else if (gameState.phase === 'TRUMP_SELECTION' && gameState.highestBid.playerId === myPeerId) {
            showOverlay = true;
            trumpPanel.style.display = 'flex';

            teamCardsContainer.innerHTML = '';
            let allowedCards = Math.floor((gameState.players.length - 2) / 2);
            for (let i = 0; i < allowedCards; i++) {
                const selectorDiv = document.createElement('div');

                const rankSelect = document.createElement('select');
                rankSelect.className = 'team-rank-select';
                values.forEach(v => rankSelect.appendChild(new Option(v, v)));

                const suitSelect = document.createElement('select');
                suitSelect.className = 'team-suit-select';
                suits.forEach(s => suitSelect.appendChild(new Option(s, s)));

                selectorDiv.appendChild(rankSelect); selectorDiv.appendChild(suitSelect);
                teamCardsContainer.appendChild(selectorDiv);
            }
        }

        actionOverlay.style.display = showOverlay ? 'flex' : 'none';
    }

    // 6. Game Over Modal
    if (gameState.phase === 'GAMEOVER') {
        scorecard.style.display = 'block';
        modalBtn.style.display = isHost ? 'block' : 'none';

        let bTeamHtml = ''; let bTotal = 0;
        let dTeamHtml = ''; let dTotal = 0;

        gameState.players.forEach(p => {
            if (p.team === 'BIDDER_TEAM') {
                bTeamHtml += `<div>${cleanPlayerName(p.name)}: ${p.points}</div>`;
                bTotal += p.points;
            } else {
                dTeamHtml += `<div>${cleanPlayerName(p.name)}: ${p.points}</div>`;
                dTotal += p.points;
            }
        });

        document.getElementById('bidder-stats').innerHTML = bTeamHtml;
        document.getElementById('defender-stats').innerHTML = dTeamHtml;
        document.getElementById('bidder-total').textContent = bTotal;
        document.getElementById('defender-total').textContent = dTotal;
        document.getElementById('bid-target').textContent = gameState.highestBid.amount;

        const won = bTotal >= gameState.highestBid.amount;
        document.getElementById('score-title').textContent = won ? "Bidder Team WON! 🎉" : "Bidder Team LOST! ❌";
        document.getElementById('score-title').style.color = won ? "#4CAF50" : "#f44336";
    } else {
        scorecard.style.display = 'none';
    }
}

function createCardElement(card, isClickable, isPlayable = true) {
    const cardEl = document.createElement('div');
    cardEl.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
    cardEl.textContent = `${card.value}${card.suit}`;

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

function saveGame() {
    const payload = {
        gameState: gameState,
        gameStats: gameStats
    };

    const dataStr = JSON.stringify(payload, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', `kalli_tilli_backup_${Date.now()}.json`);
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
                // Preserve current network IDs while taking game state data
                const currentConnections = gameState.players.map(p => ({ id: p.id, name: p.name }));

                gameState = parsed.gameState;
                gameStats = parsed.gameStats || {};

                // Re-bind connected player IDs to loaded records
                currentConnections.forEach((conn, index) => {
                    if (gameState.players[index]) {
                        gameState.players[index].id = conn.id;
                    }
                });

                broadcastState();
                alert("Game state and stats restored.");
            } else {
                throw new Error("Invalid structure");
            }
        } catch(err) {
            alert("Failed to parse the save file.");
        }
    };
    reader.readAsText(file);
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
}

// UI Bindings
document.getElementById('startGameBtn').addEventListener('click', () => {
    if (isHost) { startDeal(); broadcastState(); }
});

document.getElementById('modalBackToLobbyBtn').addEventListener('click', () => {
    if (isHost) {
        gameState.phase = 'LOBBY';

        // Merge any spectators into active players
        if (gameState.spectators && gameState.spectators.length > 0) {
            gameState.spectators.forEach(s => {
                const cleanName = s.name.replace(" (Spectator)", "");
                gameState.players.push({ 
                    id: s.id, 
                    name: cleanName, 
                    hand: [], 
                    wonCards: [], 
                    points: 0, 
                    currentBid: 0, 
                    team: 'UNKNOWN' 
                });
            });
            gameState.spectators = [];
        }

        // Reset round-specific player properties
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
        gameState.biddingDeadline = null;

        broadcastState();
    }
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
            broadcastState(); 
        }
    }
    else if (hostConnection) {
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

document.getElementById('closeWonCardsBtn')?.addEventListener('click', () => {
    document.getElementById('won-cards-modal').style.display = 'none';
});

document.getElementById('hostMenuToggle')?.addEventListener('click', () => {
    const menu = document.getElementById('host-dropdown');
    const currentDisplay = window.getComputedStyle(menu).display;
    menu.style.display = (currentDisplay === 'none') ? 'flex' : 'none';
});

document.getElementById('hostReshuffleBtn')?.addEventListener('click', () => {
    if(isHost) { startDeal(); broadcastState(); }
});
document.getElementById('hostBackToLobbyBtn')?.addEventListener('click', () => {
    if(isHost) { document.getElementById('modalBackToLobbyBtn').click(); }
});

document.getElementById('saveBtn')?.addEventListener('click', saveGame);
document.getElementById('loadInput')?.addEventListener('change', loadGame);
