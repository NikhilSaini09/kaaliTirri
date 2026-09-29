// cpu.js - Advanced AI Engine for Kaali Tirri
//
// Fairness rule for every function in this file: only ever reads `player.hand` (the CPU's
// own cards), `state.board` / `wonCards` (cards already played, public knowledge), and
// revealed team status. Never looks at another player's `.hand` - a CPU makes decisions
// with exactly the information a human in its seat would have.

function getBestCardToPlay(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;
    const choice = getBestCardToPlayInner(playerId, state);
    // Defensive: every scenario branch above should always return a card, but if some future
    // edit leaves a gap, falling through to an illegal null move would stall the whole table.
    return choice || player.hand[0];
}

function getBestCardToPlayInner(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;

    // 1. DEDUCE GAME CONTEXT & VALID MOVES
    let validCards = player.hand;
    let hasLead = false;
    let leadSuit = null;

    if (state.board.length > 0) {
        leadSuit = state.board[0].suit;
        hasLead = player.hand.some(c => c.suit === leadSuit);
        if (hasLead) validCards = player.hand.filter(c => c.suit === leadSuit);
    }

    if (validCards.length === 1) return validCards[0];

    // 2. REBUILD MEMORY (Card Counting)
    const playedCards = [];
    state.players.forEach(p => {
        if (p.wonCards) playedCards.push(...p.wonCards);
    });
    playedCards.push(...state.board);

    const isBoss = (card) => {
        const rankIdx = getCardRank(card);
        for (let r = rankIdx + 1; r < values.length; r++) {
            const higherVal = values[r];
            const isPlayed = playedCards.some(pc => pc.value === higherVal && pc.suit === card.suit);
            const inHand = player.hand.some(hc => hc.value === higherVal && hc.suit === card.suit);
            if (!isPlayed && !inHand) return false; // Someone else still holds a higher card
        }
        return true;
    };

    // 3. DETERMINE TRUE TEAM ALLIANCE
    let myTrueTeam = player.team;
    if (myTrueTeam === 'UNKNOWN') {
        const holdsPartnerCard = player.hand.some(c => state.calledCards.includes(`${c.value}${c.suit}`));
        if (holdsPartnerCard) myTrueTeam = 'BIDDER_TEAM';
        else if (state.calledCards.length === 0) myTrueTeam = 'DEFENDER_TEAM';
    }

    // 4. ANALYZE CURRENT BOARD
    let currentWinnerCard = null;
    let currentWinnerId = null;
    let isTeammateWinning = false;
    let trickPoints = 0;

    if (state.board.length > 0) {
        currentWinnerCard = state.board[0];
        trickPoints += getCardPoints(currentWinnerCard);

        for (let i = 1; i < state.board.length; i++) {
            const c = state.board[i];
            trickPoints += getCardPoints(c);
            const isTrump = c.suit === state.trumpSuit;
            const winIsTrump = currentWinnerCard.suit === state.trumpSuit;
            
            if (isTrump && !winIsTrump) {
                currentWinnerCard = c;
            } else if ((isTrump && winIsTrump) || (!isTrump && !winIsTrump && c.suit === leadSuit)) {
                if (getCardRank(c) > getCardRank(currentWinnerCard)) currentWinnerCard = c;
            }
        }

        currentWinnerId = currentWinnerCard.playedBy;
        const winningPlayer = state.players.find(p => p.id === currentWinnerId);
        if (winningPlayer) {
            if (winningPlayer.team !== 'UNKNOWN' && winningPlayer.team === myTrueTeam) {
                isTeammateWinning = true;
            }
            if (currentWinnerId === playerId) isTeammateWinning = true;
        }
    }

    // --- STRATEGY SCENARIO 1: LEADING THE TRICK ---
    if (state.board.length === 0) {
        // Priority 1: Play a non-trump Boss card (Guaranteed trick win without wasting trump)
        let nonTrumpBosses = validCards.filter(c => c.suit !== state.trumpSuit && isBoss(c));
        if (nonTrumpBosses.length > 0) {
            return nonTrumpBosses.sort((a,b) => getCardPoints(b) - getCardPoints(a))[0];
        }

        // Priority 2: Bleed a worthless non-trump card to void a suit safely
        let trash = validCards.filter(c => c.suit !== state.trumpSuit && getCardPoints(c) === 0);
        if (trash.length > 0) {
            return trash.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
        }
        
        // Priority 3: Forced to play trump or point cards; play the lowest rank
        return validCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
    }

    // --- STRATEGY SCENARIO 2: MUST FOLLOW SUIT ---
    if (hasLead) {
        let winningCards = validCards.filter(c => {
            if (currentWinnerCard.suit === state.trumpSuit && leadSuit !== state.trumpSuit) return false;
            return getCardRank(c) > getCardRank(currentWinnerCard);
        });

        if (isTeammateWinning) {
            // Teammate has it. Duck safely by playing the lowest card.
            return validCards.sort((a,b) => {
                if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                return getCardRank(a) - getCardRank(b);
            })[0];
        } else {
            // Enemy/Unknown is winning.
            if (winningCards.length > 0) {
                // Try to beat them as cheaply as possible
                return winningCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
            } else {
                // Cannot win. Dump lowest value trash.
                return validCards.sort((a,b) => {
                    if (getCardPoints(a) !== getCardPoints(b)) return getCardPoints(a) - getCardPoints(b);
                    return getCardRank(a) - getCardRank(b);
                })[0];
            }
        }
    }

    // --- STRATEGY SCENARIO 3: VOID IN LEAD SUIT (Can Trump or Discard) ---
    let trumps = validCards.filter(c => c.suit === state.trumpSuit);
    let nonTrumps = validCards.filter(c => c.suit !== state.trumpSuit);

    if (isTeammateWinning) {
        // Teammate is winning! Feed them points (up to 10pts, keep 30pt Kaali Tirri safe just in case).
        if (nonTrumps.length > 0) {
            let safePointsToFeed = nonTrumps.filter(c => getCardPoints(c) <= 10);
            if (safePointsToFeed.length > 0) return safePointsToFeed.sort((a,b) => getCardPoints(b) - getCardPoints(a))[0];
            return nonTrumps.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
        }
        // Forced to trump a trick our team is already winning. Play lowest trump.
        return trumps.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
    } else {
        // Enemy is winning. Should we trump it?
        let winningTrumps = trumps.filter(c => {
            if (currentWinnerCard.suit === state.trumpSuit) return getCardRank(c) > getCardRank(currentWinnerCard);
            return true;
        });

        if (winningTrumps.length > 0) {
            // Trump if the trick is juicy (>= 10 points) OR if we have a cheap 0-point trump to spare
            if (trickPoints >= 10 || getCardPoints(winningTrumps[0]) === 0) {
                return winningTrumps.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
            }
        }

        // Refuse to waste a high trump on a 0-point trick, or we simply have no trumps. Dump trash.
        if (nonTrumps.length > 0) {
            let zeroPointTrash = nonTrumps.filter(c => getCardPoints(c) === 0);
            if (zeroPointTrash.length > 0) {
                // Dump highest rank 0-point card to clear out high-liability garbage
                return zeroPointTrash.sort((a,b) => getCardRank(b) - getCardRank(a))[0];
            }
            // Forced to dump points. Dump the lowest points possible.
            return nonTrumps.sort((a,b) => getCardPoints(a) - getCardPoints(b))[0];
        }

        // Absolutely forced to play a trump on a lost trick
        return validCards.sort((a,b) => getCardRank(a) - getCardRank(b))[0];
    }
}

/**
 * Raw hand-strength score used both for the bid ceiling and (implicitly, via honesty of
 * design) nowhere else - it never peeks at anyone else's cards or the eventual trump suit,
 * since neither is known yet at bidding time.
 */
function evaluateCpuHandStrength(hand) {
    let score = 0;
    const bySuit = {};
    hand.forEach(c => {
        bySuit[c.suit] = (bySuit[c.suit] || 0) + 1;
        if (c.value === 'A') score += 14;
        else if (c.value === 'K') score += 10;
        else if (c.value === 'Q') score += 7;
        else if (c.value === 'J') score += 4;
        else if (c.value === '10') score += 2;
        if (c.value === '5') score += 3;
        if (c.suit === '♠' && c.value === '3') score += 22; // holding Kaali Tirri itself is huge
    });
    // A long suit is a strong trump candidate - reward whichever suit runs deepest.
    const longest = Object.keys(bySuit).length ? Math.max(...Object.values(bySuit)) : 0;
    score += Math.max(0, longest - 3) * 6;
    return score;
}

/**
 * The highest amount this CPU is willing to bid this hand, computed once from raw hand
 * strength and clamped into the legal [MIN_BID, MAX_BID] range on a multiple of 5.
 */
function getCpuMaxBid(hand) {
    const strength = evaluateCpuHandStrength(hand);
    const raw = MIN_BID + strength * 3.2;
    const capped = Math.max(MIN_BID, Math.min(MAX_BID, raw));
    return Math.floor(capped / 5) * 5;
}

/**
 * Trump suit + partner calls for a CPU that won the bid. Trump is whichever suit it holds
 * the most (and highest-value) cards of; partner calls prioritize the strongest ranks it
 * does NOT hold itself, spread across suits, since calling a card already in your own hand
 * can never find a teammate.
 */
function getCpuTrumpChoice(player, numPlayers) {
    const bySuit = {};
    suits.forEach(s => bySuit[s] = []);
    player.hand.forEach(c => { if (bySuit[c.suit]) bySuit[c.suit].push(c); });

    let bestSuit = suits[0], bestScore = -1;
    suits.forEach(s => {
        const cards = bySuit[s];
        const score = cards.length * 10 + cards.reduce((sum, c) => sum + getCardPoints(c), 0);
        if (score > bestScore) { bestScore = score; bestSuit = s; }
    });

    const allowedCards = Math.floor((numPlayers - 2) / 2);
    const ownSet = new Set(player.hand.map(c => `${c.value}${c.suit}`));
    const calls = [];
    const priorityValues = ['A', 'K', 'Q', 'J', '10'];
    outer:
    for (const v of priorityValues) {
        for (const s of suits) {
            if (calls.length >= allowedCards) break outer;
            const code = `${v}${s}`;
            if (!ownSet.has(code) && calls.indexOf(code) === -1) calls.push(code);
        }
    }
    return { suit: bestSuit, calls: calls };
}