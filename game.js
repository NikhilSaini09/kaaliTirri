const suits = ['♠', '♥', '♣', '♦'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function getCardPoints(card) {
    if (card.value === 'A' || card.value === 'K' || card.value === 'Q' ||
                card.value === 'J'|| card.value === '10' ) return 10;
    if (card.value === '5') return 5;
    if (card.suit === '♠' && card.value === '3') return 30;
    return 0; 
}

function getCardRank(card) {
    return values.indexOf(card.value);
}

function sortHand(hand) {
    hand.sort((a, b) => {
        if (a.suit !== b.suit) return suits.indexOf(a.suit) - suits.indexOf(b.suit);
        return getCardRank(a) - getCardRank(b);
    });
}

const MIN_BID = 130;
const MAX_BID = 250;
const BIDDING_TIME_MS = 30000;
const TRUMP_SELECTION_TIME_MS = 60000;
const TURN_TIME_MS = 30000;
const RECONNECT_GRACE_MS = 5000;

let gameState = {
    phase: 'LOBBY',       // LOBBY, BIDDING, TRUMP_SELECTION, PLAYING, TRICK_EVALUATION, GAMEOVER
    deck: [],
    board: [],            
    players: [],          
    dealerIndex: 0,       
    turnIndex: 0,         
    highestBid: { playerId: null, amount: 0, playerName: "" },
    trumpSuit: null,      
    calledCards: [],
    originalCalledCards: [],
    spectators: [],
    excludedIds: [],
    lobbyOrder: [],
    disconnectedIds: [],
    disconnectedAt: {},
    biddingDeadline: null,
    turnDeadline: null,
    trumpSelectionDeadline: null,
    isPaused: false,
    pausedRemaining: null
};
// Schema: { "Alice": { gamesPlayed: 3, wins: 2, losses: 1 }, ... }
let gameStats = {};
let playerData = [];

const MIN_PLAYERS = 2;

function stripSpectatorTag(name) {
    return name.replace(' (Spectator)', '');
}

function getLobbyMembers() {
    const members = [
        ...gameState.players.map(p => ({ id: p.id, name: p.name, isCPU: !!p.isCPU })),
        ...(gameState.spectators || []).map(s => ({ id: s.id, name: stripSpectatorTag(s.name), isCPU: !!s.isCPU }))
    ];
    const order = gameState.lobbyOrder || [];
    const rank = id => { const i = order.indexOf(id); return i === -1 ? order.length : i; };
    return members.sort((a, b) => rank(a.id) - rank(b.id));
}

function isDisconnected(id) {
    return (gameState.disconnectedIds || []).includes(id);
}

function hasGraceExpired(id) {
    if (!isDisconnected(id)) return false;
    const at = gameState.disconnectedAt && gameState.disconnectedAt[id];
    if (!at) return true;
    return Date.now() - at >= RECONNECT_GRACE_MS;
}

function toggleSeat(targetId) {
    if (!isHost || gameState.phase !== 'LOBBY') return;
    if (isDisconnected(targetId)) return;
    if (!gameState.excludedIds) gameState.excludedIds = [];

    const idx = gameState.excludedIds.indexOf(targetId);
    if (idx === -1) gameState.excludedIds.push(targetId);
    else gameState.excludedIds.splice(idx, 1);
    broadcastState();
}

const MAX_CPU_PLAYERS = 7;

function addCpuPlayer() {
    if (!isHost || gameState.phase !== 'LOBBY') return;
    const existingCpuCount = gameState.players.filter(p => p.isCPU).length;
    if (existingCpuCount >= MAX_CPU_PLAYERS) return;
    const id = 'cpu_' + Math.random().toString(36).slice(2, 9);
    gameState.players.push({
        id, name: `BOT${existingCpuCount + 1}`, hand: [], wonCards: [], points: 0,
        currentBid: 0, team: 'UNKNOWN', isCPU: true
    });
    broadcastState();
}

function moveMember(targetId, dir) {
    if (!isHost || gameState.phase !== 'LOBBY') return;
    const order = getLobbyMembers().map(m => m.id);
    const i = order.indexOf(targetId);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    gameState.lobbyOrder = order;
    broadcastState();
}

function applySeatSelection() {
    const excluded = new Set(gameState.excludedIds || []);
    const members = getLobbyMembers().filter(m => !isDisconnected(m.id));
    const seated = members.filter(m => !excluded.has(m.id));
    if (seated.length < MIN_PLAYERS) return false;

    gameState.players = seated.map(m => ({
        id: m.id, name: m.name, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN', isCPU: !!m.isCPU
    }));
    gameState.spectators = members
        .filter(m => excluded.has(m.id))
        .map(m => ({ id: m.id, name: m.name + ' (Spectator)', isCPU: !!m.isCPU }));
    gameState.lobbyOrder = members.map(m => m.id);
    gameState.disconnectedIds = [];
    gameState.disconnectedAt = {};
    return true;
}

function generateDeck() {
    let deck = [];
    for (let suit of suits) {
        for (let value of values) {
            deck.push({ suit, value, id: Math.random().toString(36).slice(2, 9) }); 
        }
    }
    return deck;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function isCardPlayable(playerId, card) {
    if (gameState.phase !== 'PLAYING') return false;
    
    const playerIndex = gameState.players.findIndex(p => p.id === playerId);
    if (gameState.turnIndex !== playerIndex) return false; 

    if (gameState.board.length === 0) return true; 

    const leadSuit = gameState.board[0].suit;
    if (card.suit === leadSuit) return true; 

    const hasLeadSuit = gameState.players[playerIndex].hand.some(c => c.suit === leadSuit);
    if (hasLeadSuit) return false; 

    return true; 
}

let trickEvalTimeout = null;
function handlePlayCard(playerId, playedCard) {
    if (gameState.isPaused) return;
    if (!playedCard || !playedCard.id) return;

    const playerIndex = gameState.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return;
    const player = gameState.players[playerIndex];

    const cardIndex = player.hand.findIndex(c => c.id === playedCard.id);
    if (cardIndex === -1) return;

    const realCard = player.hand[cardIndex];
    if (!isCardPlayable(playerId, realCard)) return;

    const [card] = player.hand.splice(cardIndex, 1);
    card.playedBy = playerId; 
    gameState.board.push(card);
    
    const cardStr = `${card.value}${card.suit}`;
    if (gameState.calledCards.includes(cardStr)) {
        player.team = 'BIDDER_TEAM';
        gameState.calledCards = gameState.calledCards.filter(c => c !== cardStr);

        if (gameState.calledCards.length === 0) {
            gameState.players.forEach(p => {
                if (p.team === 'UNKNOWN') {
                    p.team = 'DEFENDER_TEAM';
                }
            });
        }
    }

    if (gameState.board.length === gameState.players.length) {
        gameState.phase = 'TRICK_EVALUATION';
        gameState.turnDeadline = null;
        trickEvalTimeout = setTimeout(() => {
            evaluateTrick();
            broadcastState();
        }, 2000);
    } else {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
        resetTurnTimer();
    }
}

function evaluateTrick() {
    if(gameState.board.length === 0) return;
    const leadSuit = gameState.board[0].suit;
    let winningCard = gameState.board[0];

    for (let i = 1; i < gameState.board.length; i++) {
        const card = gameState.board[i];
        const isTrump = card.suit === gameState.trumpSuit;
        const winningIsTrump = winningCard.suit === gameState.trumpSuit;

        if (isTrump && !winningIsTrump) {
            winningCard = card;
        } else if ((isTrump && winningIsTrump) || (!isTrump && !winningIsTrump && card.suit === leadSuit)) {
            if (getCardRank(card) > getCardRank(winningCard)) {
                winningCard = card;
            }
        }
    }

    if (gameState.players.some(p => p.isCPU) && typeof cpuObserveTrick === 'function') cpuObserveTrick(gameState, gameState.board, winningCard.playedBy);
    const trickPoints = gameState.board.reduce((sum, c) => sum + getCardPoints(c), 0);
    const winnerIndex = gameState.players.findIndex(p => p.id === winningCard.playedBy);
    
    gameState.players[winnerIndex].points += trickPoints;
    gameState.players[winnerIndex].wonCards.push(...gameState.board); 

    gameState.turnIndex = winnerIndex;
    gameState.board = []; 

    if (gameState.players[0].hand.length === 0) {
        gameState.turnDeadline = null;
        evaluateRoundEnd();
    } else {
        gameState.phase = 'PLAYING';
        resetTurnTimer();
    }
}

function evaluateRoundEnd() {
    gameState.phase = 'GAMEOVER';
    
    gameState.players.forEach(p => {
        if (p.team === 'UNKNOWN') p.team = 'DEFENDER_TEAM';
    });

    let bTotal = 0;
    gameState.players.forEach(p => {
        if (p.team === 'BIDDER_TEAM') bTotal += p.points;
    });

    const bidderWon = bTotal >= gameState.highestBid.amount;

    gameState.players.forEach(p => {
        if(p.name.includes("(Spectator)")) return;
        const cleanName = p.name.replace(" (Host)", "").replace(" (H)", "").trim();
        
        if (!gameStats[cleanName]) {
            gameStats[cleanName] = { gamesPlayed: 0, wins: 0, losses: 0 };
        }
        
        gameStats[cleanName].gamesPlayed += 1;

        const isBidderTeam = p.team === 'BIDDER_TEAM';
        if ((bidderWon && isBidderTeam) || (!bidderWon && !isBidderTeam)) {
            gameStats[cleanName].wins += 1;
        } else {
            gameStats[cleanName].losses += 1;
        }

        gameStats[cleanName].winRate = ((gameStats[cleanName].wins / gameStats[cleanName].gamesPlayed) * 100).toFixed(2) + '%';
    });

    if (typeof sendGameStats === 'function') sendGameStats();
}

const EVICTION_ORDER = [];
const evictionValues = ['2', '3', '4', '6', '7', '8', '9'];
const evictionSuits = ['♦', '♣', '♥', '♠'];
for (let v of evictionValues) {
    for (let s of evictionSuits) {
        if (!(v === '3' && s === '♠')) EVICTION_ORDER.push(`${v}${s}`);
    }
}
function startDeal() {
    if (trickEvalTimeout) {
        clearTimeout(trickEvalTimeout);
        trickEvalTimeout = null;
    }

    let fullDeck = generateDeck();
    shuffle(fullDeck);
    shuffle(fullDeck);

    const numPlayers = gameState.players.length;
    if(numPlayers === 0) return;

    const cardsPerPlayer = Math.min(13, Math.trunc(52 / numPlayers));
    const totalCardsToDeal = cardsPerPlayer * numPlayers;
    const cardsToRemoveCount = 52 - totalCardsToDeal;

    const cardsToEvict = EVICTION_ORDER.slice(0, cardsToRemoveCount);

    gameState.deck = fullDeck.filter(card => !cardsToEvict.includes(`${card.value}${card.suit}`));
    shuffle(gameState.deck);
    shuffle(gameState.deck);
    
    gameState.board = [];
    gameState.highestBid = { playerId: null, amount: 0, playerName: "" };
    gameState.trumpSuit = null;
    gameState.calledCards = [];
    gameState.originalCalledCards = [];

    gameState.players.forEach(p => {
        p.hand = [];
        p.wonCards = [];
        p.hasFolded = false;
        p.points = 0;
        p.team = 'UNKNOWN';
    });

    gameState.biddingDeadline = null;
    gameState.turnDeadline = null;
    gameState.trumpSelectionDeadline = null;
    gameState.isPaused = false;
    gameState.pausedRemaining = null;

    cpuBidPlans = {};
    cpuTrumpPlan = null;
    cpuMovePlan = null;

    gameState.dealerIndex = (gameState.dealerIndex + 1) % numPlayers;
    let currentPlayer = (gameState.dealerIndex + 1) % numPlayers;
    while (gameState.deck.length > 0) {
        gameState.players[currentPlayer].hand.push(gameState.deck.pop());
        currentPlayer = (currentPlayer + 1) % numPlayers;
    }

    gameState.players.forEach(p => sortHand(p.hand));
    gameState.phase = 'BIDDING';
}

function enterTrumpSelection() {
    gameState.phase = 'TRUMP_SELECTION';
    gameState.biddingDeadline = null;
    gameState.trumpSelectionDeadline = Date.now() + TRUMP_SELECTION_TIME_MS;
}

function handlePlaceBid(playerId, amount) {
    if (gameState.isPaused) return { error: "Game is paused." };
    if (gameState.phase !== 'BIDDING') return;
    const player = gameState.players.find(p => p.id === playerId);
    if (!player || player.hasFolded) return { error: "You have already folded." };

    const amt = parseInt(amount);
    if (isNaN(amt) || amt % 5 !== 0) {
        return { error: "Bid must be a multiple of 5." };
    }
    if (amt < MIN_BID || amt > MAX_BID) {
        return { error: `Bid must be between ${MIN_BID} and ${MAX_BID}.` };
    }

    if (amt > gameState.highestBid.amount) {
        gameState.highestBid = { playerId: playerId, amount: amt, playerName: player.name };
        resetBiddingTimer();

        const activePlayers = gameState.players.filter(p => !p.hasFolded);
        if (activePlayers.length === 1 || amt === MAX_BID) {
            enterTrumpSelection();
        }
        return { success: true };
    }
    return { error: "Bid must be higher than current highest." };
}

function handleFold(playerId) {
    if (gameState.isPaused) return;
    if (gameState.phase !== 'BIDDING') return;
    if (gameState.highestBid.playerId === playerId) return;

    const player = gameState.players.find(p => p.id === playerId);
    if (player) player.hasFolded = true;

    const activePlayers = gameState.players.filter(p => !p.hasFolded);

    if (activePlayers.length === 0) {
        startDeal(); 
        return;
    }
    if (activePlayers.length === 1 && gameState.highestBid.playerId !== null) {
        enterTrumpSelection();
    }
}

function resetBiddingTimer() {
    gameState.biddingDeadline = Date.now() + BIDDING_TIME_MS;
}

let cpuBidInterval, bidTimeoutInterval, turnTimeoutInterval, trumpTimeoutInterval;

function startGameLoops() {
    stopGameLoops();
    const hasCPU = gameState?.players?.some(p => p.isCPU);
    if (hasCPU) {
        cpuBidInterval = setInterval(runCpuBidding, 1000);
    }
    bidTimeoutInterval = setInterval(checkBiddingTimeout, 1000);
    turnTimeoutInterval = setInterval(checkTurnTimeout, 1000);
    trumpTimeoutInterval = setInterval(checkTrumpSelectionTimeout, 1000);
}

function stopGameLoops() {
    clearInterval(cpuBidInterval);
    clearInterval(bidTimeoutInterval);
    clearInterval(turnTimeoutInterval);
    clearInterval(trumpTimeoutInterval);
}

startGameLoops();


let cpuBidPlans = {};
let cpuTrumpPlan = null;
let cpuMovePlan = null;

function runCpuBidding() {
    if (!isHost || gameState.isPaused || gameState.phase !== 'BIDDING') return;
    let changed = false;
    let plannedThisTick = false;

    gameState.players.forEach(player => {
        if (!player.isCPU || player.hasFolded) return;
        if (gameState.highestBid.playerId === player.id) return;

        let plan = cpuBidPlans[player.id];
        if (!plan) {
            if (plannedThisTick) return;
            plannedThisTick = true;
            plan = { maxBid: getCpuMaxBid(player.hand, gameState.players.length), nextActionAt: Date.now() + 1200 + Math.random() * 2200 };
            cpuBidPlans[player.id] = plan;
        }
        if (Date.now() < plan.nextActionAt) return;

        const nextAmount = gameState.highestBid.amount === 0 ? MIN_BID : gameState.highestBid.amount + 5;
        if (nextAmount <= plan.maxBid && nextAmount <= MAX_BID) {
            handlePlaceBid(player.id, nextAmount);
        } else if (gameState.highestBid.playerId === null &&
                   gameState.players.filter(p => !p.hasFolded).length === 1) {
            handlePlaceBid(player.id, MIN_BID);
        } else {
            handleFold(player.id);
        }
        plan.nextActionAt = Date.now() + 1200 + Math.random() * 2200;
        changed = true;
    });

    if (changed) broadcastState();
}

function checkBiddingTimeout() {
    if (!isHost) return;
    if (gameState.isPaused) return;
    if (gameState.phase !== 'BIDDING' || !gameState.biddingDeadline) return;
    if (Date.now() < gameState.biddingDeadline) return;

    if (gameState.highestBid.playerId === null) {
        const active = gameState.players.filter(p => !p.hasFolded);
        if (active.length === 0) { startDeal(); broadcastState(); return; }
        const randomPlayer = active[Math.floor(Math.random() * active.length)];
        gameState.highestBid = { playerId: randomPlayer.id, amount: MIN_BID, playerName: randomPlayer.name };
        enterTrumpSelection();
    } else {
        gameState.players.forEach(p => {
            if (p.id !== gameState.highestBid.playerId && !p.hasFolded) p.hasFolded = true;
        });
        enterTrumpSelection();
    }

    broadcastState();
}

function resetTurnTimer() {
    gameState.turnDeadline = Date.now() + TURN_TIME_MS;
}

function checkTurnTimeout() {
    if (!isHost) return;
    if (gameState.isPaused) return;
    if (gameState.phase !== 'PLAYING' || !gameState.turnDeadline) return;

    const player = gameState.players[gameState.turnIndex];
    if (!player) { gameState.turnDeadline = null; return; }

    if (player.isCPU) {
        if (!cpuMovePlan || cpuMovePlan.playerId !== player.id) {
            cpuMovePlan = { playerId: player.id, actAt: Date.now() + 700 + Math.random() * 1300 };
        }
        if (Date.now() < cpuMovePlan.actAt) return;
        const card = getBestCardToPlay(player.id, gameState);
        cpuMovePlan = null;
        if (card) handlePlayCard(player.id, card);
        else gameState.turnDeadline = null;
        broadcastState();
        return;
    }
    cpuMovePlan = null;

    const isPlayerDisconnected = isDisconnected(player.id);

    if (Date.now() >= gameState.turnDeadline) {
        const playableCards = player.hand.filter(c => isCardPlayable(player.id, c));
        const cardToPlay = playableCards.length > 0 
            ? playableCards[Math.floor(Math.random() * playableCards.length)] 
            : null;

        if (cardToPlay) {
            handlePlayCard(player.id, cardToPlay);
        } else {
            gameState.turnDeadline = null;
        }
        broadcastState();
        return;
    }

    if ((isPlayerDisconnected && hasGraceExpired(player.id))) {
        const cardToPlay = getBestCardToPlay(player.id, gameState);

        if (cardToPlay) {
            handlePlayCard(player.id, cardToPlay);
        } else {
            gameState.turnDeadline = null;
        }
        broadcastState();
    }
}


function autoResolveTrumpSelection() {
    gameState.trumpSelectionDeadline = null;
    const bidderId = gameState.highestBid.playerId;
    const bidderIndex = gameState.players.findIndex(p => p.id === bidderId);
    if (bidderIndex === -1) {
        startDeal();
        return;
    }
    const randomSuit = suits[Math.floor(Math.random() * suits.length)];
    const allowedCards = Math.floor((gameState.players.length - 2) / 2);
    const randomCalled = [];
    for (let i = 0; i < allowedCards; i++) {
        const v = values[Math.floor(Math.random() * values.length)];
        const s = suits[Math.floor(Math.random() * suits.length)];
        randomCalled.push(`${v}${s}`);
    }
    handleSetTrump(bidderId, randomSuit, randomCalled);
}

function checkTrumpSelectionTimeout() {
    if (!isHost) return;
    if (gameState.isPaused) return;
    if (gameState.phase !== 'TRUMP_SELECTION') return;

    const bidderId = gameState.highestBid.playerId;
    const bidder = gameState.players.find(p => p.id === bidderId);

    if (bidder && bidder.isCPU) {
        if (!cpuTrumpPlan || cpuTrumpPlan.playerId !== bidderId) {
            cpuTrumpPlan = { playerId: bidderId, actAt: Date.now() + 1000 + Math.random() * 1500 };
        }
        if (Date.now() >= cpuTrumpPlan.actAt) {
            const choice = getCpuTrumpChoice(bidder, gameState.players.length);
            cpuTrumpPlan = null;
            handleSetTrump(bidderId, choice.suit, choice.calls);
            broadcastState();
        }
        return;
    }

    const bidderDisconnected = bidderId && isDisconnected(bidderId) && hasGraceExpired(bidderId);
    const timedOut = gameState.trumpSelectionDeadline && Date.now() >= gameState.trumpSelectionDeadline;

    if (bidderDisconnected || timedOut) {
        autoResolveTrumpSelection();
        broadcastState();
    }
}

function togglePause() {
    if (!isHost) return;

    if (!gameState.isPaused) {
        gameState.pausedRemaining = null;
        if (gameState.biddingDeadline) {
            gameState.pausedRemaining = gameState.biddingDeadline - Date.now();
            gameState.biddingDeadline = null;
        } else if (gameState.turnDeadline) {
            gameState.pausedRemaining = gameState.turnDeadline - Date.now();
            gameState.turnDeadline = null;
        } else if (gameState.trumpSelectionDeadline) {
            gameState.pausedRemaining = gameState.trumpSelectionDeadline - Date.now();
            gameState.trumpSelectionDeadline = null;
        }
        gameState.isPaused = true;
    } else {
        if (gameState.pausedRemaining !== null && gameState.pausedRemaining !== undefined) {
            const remaining = Math.max(1000, gameState.pausedRemaining);
            if (gameState.phase === 'BIDDING') {
                gameState.biddingDeadline = Date.now() + remaining;
            } else if (gameState.phase === 'PLAYING') {
                gameState.turnDeadline = Date.now() + remaining;
            } else if (gameState.phase === 'TRUMP_SELECTION') {
                gameState.trumpSelectionDeadline = Date.now() + remaining;
            }
        }
        gameState.pausedRemaining = null;
        gameState.isPaused = false;
    }
    broadcastState();
}

function isValidCardCode(code) {
    if (typeof code !== 'string' || code.length < 2) return false;
    const suit = code.slice(-1);
    const value = code.slice(0, -1);
    return suits.includes(suit) && values.includes(value);
}

function handleSetTrump(playerId, suit, calledCardsArray) {
    if (gameState.isPaused) return;
    if (gameState.phase !== 'TRUMP_SELECTION' || gameState.highestBid.playerId !== playerId) return;
    if (!suits.includes(suit)) return;
    const cleanCalled = (Array.isArray(calledCardsArray) ? calledCardsArray : []).filter(isValidCardCode);

    gameState.trumpSuit = suit;
    gameState.trumpSelectionDeadline = null;

    const allowedCards = Math.floor((gameState.players.length - 2) / 2);
    gameState.calledCards = cleanCalled.slice(0, allowedCards);
    gameState.originalCalledCards = cleanCalled;
    
    const bidderIndex = gameState.players.findIndex(p => p.id === playerId);
    gameState.players[bidderIndex].team = 'BIDDER_TEAM';
    gameState.turnIndex = bidderIndex;

    if (allowedCards === 0) {
        gameState.players.forEach(p => {
            if (p.id !== playerId) p.team = 'DEFENDER_TEAM';
        });
    }
    
    gameState.phase = 'PLAYING';
    resetTurnTimer();
}

function getSanitizedStateForClient(clientId) {
    let safeState = JSON.parse(JSON.stringify(gameState));
    
    safeState.players.forEach(p => {
        if (p.id !== clientId) {
            const cardCount = p.hand.length;
            p.hand = new Array(cardCount).fill(null);
        }
    });
    return safeState;
}
