const suits = ['♠', '♥', '♦', '♣'];
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

const MIN_BID = 130;
const MAX_BID = 250;
const BIDDING_TIME_MS = 30000;

// --- State Structure ---
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
    spectators: [],
    biddingDeadline: null // epoch ms; host auto-resolves bidding once this passes
};
let gameStats = {}; 
// Schema: { "Alice": { gamesPlayed: 3, wins: 2, losses: 1 }, ... }

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

function handlePlayCard(playerId, playedCard) {
    if (!isCardPlayable(playerId, playedCard)) return;

    const playerIndex = gameState.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return;
    const player = gameState.players[playerIndex];
    
    const cardIndex = player.hand.findIndex(c => c.id === playedCard.id);
    if (cardIndex !== -1) {
        const [card] = player.hand.splice(cardIndex, 1);
        card.playedBy = playerId; 
        gameState.board.push(card);
        
        // Team Reveal Logic
        const cardStr = `${card.value}${card.suit}`;
        if (gameState.calledCards.includes(cardStr)) {
            player.team = 'BIDDER_TEAM';
            gameState.calledCards = gameState.calledCards.filter(c => c !== cardStr);

            // Once ALL called cards have appeared on the table,
            // everyone remaining who isn't on the bidder team is officially exposed as a DEFENDER
            if (gameState.calledCards.length === 0) {
                gameState.players.forEach(p => {
                    if (p.team === 'UNKNOWN') {
                        p.team = 'DEFENDER_TEAM';
                    }
                });
            }
        }

        if (gameState.board.length === gameState.players.length) {
            // Lock board for evaluation
            gameState.phase = 'TRICK_EVALUATION';
            setTimeout(() => {
                evaluateTrick();
                broadcastState(); // Broadcast after evaluation finishes
            }, 2000);
        } else {
            gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
        }
    }
}

function evaluateTrick() {
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

    const trickPoints = gameState.board.reduce((sum, c) => sum + getCardPoints(c), 0);
    const winnerIndex = gameState.players.findIndex(p => p.id === winningCard.playedBy);
    
    gameState.players[winnerIndex].points += trickPoints;
    gameState.players[winnerIndex].wonCards.push(...gameState.board); 

    gameState.turnIndex = winnerIndex;
    gameState.board = []; 

    if (gameState.players[0].hand.length === 0) {
        evaluateRoundEnd();
    } else {
        gameState.phase = 'PLAYING';
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

    // Record stats permanently by player name without affecting gameplay
    gameState.players.forEach(p => {
        if(p.name.includes("(Spectator)")) return; // Skip spectators
        // Strip out temporary host/spectator labels for clean keys
        const cleanName = p.name.replace(" (Host)", "").replace(" (Spectator)", "").trim();
        
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
    });
}

function startDeal() {
    let fullDeck = generateDeck();
    shuffle(fullDeck);
    shuffle(fullDeck);

    const numPlayers = gameState.players.length;
    if(numPlayers === 0) return;

    const cardsPerPlayer = Math.min(13, Math.trunc(52 / numPlayers));
    const totalCardsToDeal = cardsPerPlayer * numPlayers;
    const cardsToRemoveCount = 52 - totalCardsToDeal;

    const evictionValues = ['2', '3', '4', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const evictionSuits = ['♦', '♣', '♥', '♠'];
    let evictionList = [];
    
    for (let v of evictionValues) {
        for (let s of evictionSuits) {
            if (!(v === '3' && s === '♠')) { 
                evictionList.push(`${v}${s}`);
            }
        }
    }

    const cardsToEvict = evictionList.slice(0, cardsToRemoveCount);

    gameState.deck = fullDeck.filter(card => !cardsToEvict.includes(`${card.value}${card.suit}`));
    shuffle(gameState.deck);
    shuffle(gameState.deck);
    
    gameState.board = [];
    gameState.highestBid = { playerId: null, amount: 0, playerName: "" };
    gameState.trumpSuit = null;
    gameState.calledCards = [];

    gameState.players.forEach(p => {
        p.hand = [];
        p.wonCards = [];
        p.hasFolded = false;
        p.points = 0;
        p.team = 'UNKNOWN'; // Reset teams
    });

    resetBiddingTimer();

    // 6. Deal the playable deck evenly
    let currentPlayer = 0;
    while (gameState.deck.length > 0) {
        gameState.players[currentPlayer].hand.push(gameState.deck.pop());
        currentPlayer = (currentPlayer + 1) % numPlayers;
    }

    gameState.phase = 'BIDDING';
}

function handlePlaceBid(playerId, amount) {
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
        resetBiddingTimer(); // a new high bid gives everyone else a fresh window to respond

        const activePlayers = gameState.players.filter(p => !p.hasFolded);
        if (activePlayers.length === 1 || amt === MAX_BID) {
            gameState.phase = 'TRUMP_SELECTION';
            gameState.biddingDeadline = null;
        }
        return { success: true };
    }
    return { error: "Bid must be higher than current highest." };
}

function handleFold(playerId) {
    if (gameState.phase !== 'BIDDING') return;
    if (gameState.highestBid.playerId === playerId) return;

    const player = gameState.players.find(p => p.id === playerId);
    if (player) player.hasFolded = true;

    const activePlayers = gameState.players.filter(p => !p.hasFolded);

    if (activePlayers.length === 0) {
        // Trigger a re-deal automatically
        startDeal(); 
        return;
    }
    if (activePlayers.length === 1 && gameState.highestBid.playerId !== null) {
        gameState.phase = 'TRUMP_SELECTION';
        gameState.biddingDeadline = null;
    }
}

// Gives the table a fresh 30-second window to bid or fold.
function resetBiddingTimer() {
    gameState.biddingDeadline = Date.now() + BIDDING_TIME_MS;
}

function checkBiddingTimeout() {
    if (!isHost) return;
    if (gameState.phase !== 'BIDDING' || !gameState.biddingDeadline) return;
    if (Date.now() < gameState.biddingDeadline) return;

    if (gameState.highestBid.playerId === null) {
        // Nobody bid at all in time — hand a random active player the minimum bid.
        const active = gameState.players.filter(p => !p.hasFolded);
        if (active.length === 0) { startDeal(); broadcastState(); return; }
        const randomPlayer = active[Math.floor(Math.random() * active.length)];
        gameState.highestBid = { playerId: randomPlayer.id, amount: MIN_BID, playerName: randomPlayer.name };
        gameState.phase = 'TRUMP_SELECTION';
    } else {
        // Everyone who hasn't matched the high bid is timed out and folded.
        gameState.players.forEach(p => {
            if (p.id !== gameState.highestBid.playerId && !p.hasFolded) p.hasFolded = true;
        });
        gameState.phase = 'TRUMP_SELECTION';
    }

    gameState.biddingDeadline = null;
    broadcastState();
}

// Ticks once a second; only the host acts on it, but it's harmless to run everywhere.
setInterval(checkBiddingTimeout, 1000);

function handleSetTrump(playerId, suit, calledCardsArray) {
    if (gameState.phase !== 'TRUMP_SELECTION' || gameState.highestBid.playerId !== playerId) return;

    gameState.trumpSuit = suit;
    gameState.calledCards = [...calledCardsArray]; 
    
    const bidderIndex = gameState.players.findIndex(p => p.id === playerId);
    gameState.players[bidderIndex].team = 'BIDDER_TEAM';
    gameState.turnIndex = bidderIndex;
    
    gameState.phase = 'PLAYING';
}

function getSanitizedStateForClient(clientId) {
    // Create a deep copy of the state
    let safeState = JSON.parse(JSON.stringify(gameState));
    
    safeState.players.forEach(p => {
        if (p.id !== clientId) {
            // Scrub other players' cards, only keep the length
            const cardCount = p.hand.length;
            p.hand = new Array(cardCount).fill(null);
        }
    });
    return safeState;
}