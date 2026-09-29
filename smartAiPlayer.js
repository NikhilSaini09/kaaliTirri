// cpu.js - Advanced AI Engine for Kaali Tirri

function getBestCardToPlay(playerId, state) {
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