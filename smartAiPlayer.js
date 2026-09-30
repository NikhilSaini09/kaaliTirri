// Fairness rule for every function in this file: a CPU only ever reads its OWN player.hand,
// plus purely public information - state.board, everyone's wonCards, revealed team status,
// and how many cards an opponent has left (a count, never contents). It never reads another
// player's real hand. Where this file needs to reason about opponents' likely cards (the
// endgame lookahead, the bidding estimate), it does so by SAMPLING plausible hands from the
// unseen-card pool - never by peeking at what's actually in anyone's hand.

function reconstructTrickHistory(state) {
    const numPlayers = state.players.length;
    if (!numPlayers) return [];
    const tricks = [];
    state.players.forEach(p => {
        const won = p.wonCards || [];
        for (let i = 0; i + numPlayers <= won.length; i += numPlayers) {
            tricks.push(won.slice(i, i + numPlayers));
        }
    });
    return tricks;
}

function resolveTrickWinnerCard(trick, trumpSuit) {
    if (!trick || trick.length === 0) return null;
    const leadSuit = trick[0].suit;
    let winner = trick[0];
    for (let i = 1; i < trick.length; i++) {
        const c = trick[i];
        const isTrump = c.suit === trumpSuit;
        const winIsTrump = winner.suit === trumpSuit;
        if (isTrump && !winIsTrump) {
            winner = c;
        } else if ((isTrump && winIsTrump) || (!isTrump && !winIsTrump && c.suit === leadSuit)) {
            if (getCardRank(c) > getCardRank(winner)) winner = c;
        }
    }
    return winner;
}

function computeVoidMap(state) {
    const voidMap = {};
    state.players.forEach(p => { voidMap[p.id] = new Set(); });

    const markTrick = (trick) => {
        if (!trick || trick.length === 0) return;
        const leadSuit = trick[0].suit;
        for (let i = 1; i < trick.length; i++) {
            const c = trick[i];
            if (c.suit !== leadSuit && c.playedBy && voidMap[c.playedBy]) {
                voidMap[c.playedBy].add(leadSuit);
            }
        }
    };

    reconstructTrickHistory(state).forEach(markTrick);
    markTrick(state.board);
    return voidMap;
}

function computeTeamAffinity(state) {
    const affinity = {};
    state.players.forEach(p => { affinity[p.id] = 0; });
    const teamOf = {};
    state.players.forEach(p => { teamOf[p.id] = p.team; });
    let affinityFactor = 2.4;

    reconstructTrickHistory(state).forEach(trick => {
        const leadSuit = trick[0].suit;
        const winnerCard = resolveTrickWinnerCard(trick, state.trumpSuit);
        if (!winnerCard) return;
        const winnerTeam = teamOf[winnerCard.playedBy];
        if (winnerTeam !== 'BIDDER_TEAM' && winnerTeam !== 'DEFENDER_TEAM') return;
        const sign = winnerTeam === 'BIDDER_TEAM' ? affinityFactor : -affinityFactor;
        affinityFactor -= 0.15;

        trick.forEach(c => {
            if (c === winnerCard) return;
            const pid = c.playedBy;
            if (!pid || teamOf[pid] !== 'UNKNOWN') return;
            const wasFree = c.suit !== leadSuit;
            const points = getCardPoints(c);
            if (wasFree && points > 0) {
                affinity[pid] = (affinity[pid] || 0) + sign * (points / 10);
            }
        });
    });

    return affinity;
}

const TEAM_AFFINITY_THRESHOLD = 3.5;
function guessTeam(playerId, state, affinity) {
    const p = state.players.find(pl => pl.id === playerId);
    if (!p) return 'UNKNOWN';
    if (p.team !== 'UNKNOWN') return p.team;
    const score = affinity ? (affinity[playerId] || 0) : 0;
    if (score >= TEAM_AFFINITY_THRESHOLD) return 'BIDDER_TEAM';
    if (score <= -TEAM_AFFINITY_THRESHOLD) return 'DEFENDER_TEAM';
    return 'UNKNOWN';
}

function determineMyTeam(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return 'UNKNOWN';
    if (player.team !== 'UNKNOWN') return player.team;

    const myCodes = new Set(player.hand.map(c => `${c.value}${c.suit}`));
    const everCalled = (state.originalCalledCards && state.originalCalledCards.length > 0)
        ? state.originalCalledCards
        : (state.calledCards || []);
    if (everCalled.length === 0) return 'DEFENDER_TEAM';
    return everCalled.some(code => myCodes.has(code)) ? 'BIDDER_TEAM' : 'DEFENDER_TEAM';
}

function getBestCardToPlay(playerId, state) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || player.hand.length === 0) return null;

    if (player.hand.length <= ENDGAME_SEARCH_MAX_HAND && state.board.length < state.players.length) {
        try {
            const leadSuit = state.board.length > 0 ? state.board[0].suit : null;
            const legal = leadSuit && player.hand.some(c => c.suit === leadSuit)
                ? player.hand.filter(c => c.suit === leadSuit)
                : player.hand;
            if (legal.length > 1) {
                const choice = getBestCardToPlayEndgame(playerId, state, legal);
                if (choice) return choice;
            }
        } catch (e) {}
    }

    let choice = getBestCardToPlayInner(playerId, state);
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

    const voidMap = computeVoidMap(state);

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

    // 3. DETERMINE TRUE TEAM ALLIANCE (certain, from our own hand vs. the full call list)
    let myTrueTeam = determineMyTeam(playerId, state);

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
        if (currentWinnerId === playerId) {
            isTeammateWinning = true;
        } else {
            const affinity = computeTeamAffinity(state);
            const effectiveWinnerTeam = guessTeam(currentWinnerId, state, affinity);
            if (effectiveWinnerTeam !== 'UNKNOWN' && effectiveWinnerTeam === myTrueTeam) {
                isTeammateWinning = true;
            }
        }
    }

    // --- STRATEGY SCENARIO 1: LEADING THE TRICK ---
    if (state.board.length === 0) {
        const others = state.players.filter(p => p.id !== playerId && p.hand.length > 0);

        const guaranteedSuits = suits.filter(s =>
            s !== state.trumpSuit &&
            others.length > 0 &&
            others.every(p => (voidMap[p.id] || new Set()).has(s)) &&
            validCards.some(c => c.suit === s)
        );
        if (guaranteedSuits.length > 0) {
            const safeCards = validCards.filter(c => guaranteedSuits.includes(c.suit));
            return safeCards.sort((a, b) => getCardRank(a) - getCardRank(b))[0];
        }

        // Priority 1: play a non-trump Boss card (Guaranteed trick win without wasting trump)
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

// ---------------------------------------------------------------------------------------
// Pure simulation engine - builds self-contained synthetic states shaped exactly like the
// real one, then reuses getBestCardToPlayInner as the "brain" for every seat during a
// rollout. Nothing here ever touches or mutates the real gameState.
// ---------------------------------------------------------------------------------------

function simPlayCard(sim, playerId, card) {
    const player = sim.players.find(p => p.id === playerId);
    if (!player) return;
    const idx = player.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
    if (idx === -1) return;
    const [played] = player.hand.splice(idx, 1);
    played.playedBy = playerId;
    sim.board.push(played);

    const code = `${played.value}${played.suit}`;
    if (sim.calledCards.includes(code)) {
        player.team = 'BIDDER_TEAM';
        sim.calledCards = sim.calledCards.filter(c => c !== code);
        if (sim.calledCards.length === 0) {
            sim.players.forEach(p => { if (p.team === 'UNKNOWN') p.team = 'DEFENDER_TEAM'; });
        }
    }

    if (sim.board.length === sim.players.length) {
        const winnerCard = resolveTrickWinnerCard(sim.board, sim.trumpSuit);
        const winner = sim.players.find(p => p.id === winnerCard.playedBy);
        const trickPoints = sim.board.reduce((s, c) => s + getCardPoints(c), 0);
        winner.points += trickPoints;
        winner.wonCards.push(...sim.board);
        sim.board = [];
        sim.turnIndex = sim.players.findIndex(p => p.id === winner.id);
    } else {
        sim.turnIndex = (sim.turnIndex + 1) % sim.players.length;
    }
}

/** Plays a synthetic state forward to completion, every seat choosing via the same shared
 *  heuristic. `guard` just protects against an unforeseen infinite loop from a bad sample. */
function runPlayout(sim) {
    let guard = 0;
    const maxSteps = sim.players.length * 14;
    while (sim.players.some(p => p.hand.length > 0) && guard < maxSteps) {
        guard++;
        const actor = sim.players[sim.turnIndex];
        if (!actor || actor.hand.length === 0) {
            sim.turnIndex = (sim.turnIndex + 1) % sim.players.length;
            continue;
        }
        const card = getBestCardToPlayInner(actor.id, sim) || actor.hand[0];
        simPlayCard(sim, actor.id, card);
    }
    return sim;
}

function unseenCardPool(state, excludeHand) {
    const seen = new Set();
    (excludeHand || []).forEach(c => seen.add(`${c.value}${c.suit}`));
    state.players.forEach(p => (p.wonCards || []).forEach(c => seen.add(`${c.value}${c.suit}`)));
    state.board.forEach(c => seen.add(`${c.value}${c.suit}`));
    const pool = [];
    suits.forEach(s => values.forEach(v => {
        const code = `${v}${s}`;
        if (!seen.has(code)) pool.push({ value: v, suit: s });
    }));
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
}

// ---------------------------------------------------------------------------------------
// 4. ENDGAME LOOKAHEAD - last few tricks only. For each of our legal plays, sample a few
//    plausible worlds (opponents dealt random-but-void-respecting hands of the right size),
//    play the rest of the hand out with the shared heuristic, and see which of our own
//    choices actually scored best on average. This is a Monte Carlo rollout, not exhaustive
//    minimax - deliberately bounded (small hand sizes, few samples) so it's cheap enough to
//    run on every relevant turn without any risk of hitching the page.
// ---------------------------------------------------------------------------------------

const ENDGAME_SEARCH_MAX_HAND = 3;
const ENDGAME_SAMPLES = 8;

function buildDeterminizedSimState(state, myId, voidMap) {
    const me = state.players.find(p => p.id === myId);
    const pool = unseenCardPool(state, me.hand);

    const simPlayers = state.players.map(p => {
        if (p.id === myId) {
            return {
                id: p.id, hand: me.hand.map(c => ({ ...c })),
                wonCards: (p.wonCards || []).map(c => ({ ...c })), team: p.team, points: p.points || 0
            };
        }
        return {
            id: p.id, hand: [],
            wonCards: (p.wonCards || []).map(c => ({ ...c })), team: p.team, points: p.points || 0
        };
    });

    state.players.forEach(p => {
        if (p.id === myId) return;
        const target = simPlayers.find(sp => sp.id === p.id);
        const need = p.hand.length; // only ever the count - never real contents
        const voids = voidMap[p.id] || new Set();
        let taken = 0;
        for (let i = 0; i < pool.length && taken < need; i++) {
            if (pool[i] && !voids.has(pool[i].suit)) {
                target.hand.push(pool[i]);
                pool[i] = null;
                taken++;
            }
        }
        if (taken < need) {
            // Voids left too few "safe" cards to fill this sample (can happen with several
            // simultaneous voids) - fall back to whatever's left so the sample stays complete.
            for (let i = 0; i < pool.length && taken < need; i++) {
                if (pool[i]) { target.hand.push(pool[i]); pool[i] = null; taken++; }
            }
        }
    });

    return {
        players: simPlayers,
        board: state.board.map(c => ({ ...c })),
        trumpSuit: state.trumpSuit,
        calledCards: [...(state.calledCards || [])],
        turnIndex: state.turnIndex
    };
}

function teamPointsIn(sim, myId, myTeam) {
    let total = 0;
    sim.players.forEach(p => {
        const t = p.team !== 'UNKNOWN' ? p.team : (p.id === myId ? myTeam : 'UNKNOWN');
        if (t === myTeam) total += p.points || 0;
    });
    return total;
}

function getBestCardToPlayEndgame(playerId, state, legalCards) {
    const myTeam = determineMyTeam(playerId, state);
    const voidMap = computeVoidMap(state);

    let bestCard = legalCards[0];
    let bestScore = -Infinity;

    legalCards.forEach(candidate => {
        let total = 0;
        let samples = 0;
        for (let s = 0; s < ENDGAME_SAMPLES; s++) {
            const sim = buildDeterminizedSimState(state, playerId, voidMap);
            simPlayCard(sim, playerId, candidate);
            runPlayout(sim);
            total += teamPointsIn(sim, playerId, myTeam);
            samples++;
        }
        const avg = samples > 0 ? total / samples : 0;
        if (avg > bestScore) { bestScore = avg; bestCard = candidate; }
    });

    return bestCard;
}

// ---------------------------------------------------------------------------------------
// 3. BIDDING - simulate a handful of full hands (random-but-legal opponent deals, played out
//    with the same shared heuristic every seat uses) to see how many points this hand
//    realistically converts into as the bidder, rather than trusting one fixed formula. This
//    is what actually fixes hands that look strong on paper (raw high-card count) but don't
//    convert well in practice (e.g. all bunched in one suit that gets trumped early).
// ---------------------------------------------------------------------------------------

const BID_SIM_SAMPLES = 6;

function simulateHandAsBidder(hand, numPlayers) {
    const cardsPerPlayer = Math.min(13, Math.floor(52 / numPlayers));
    if (hand.length > cardsPerPlayer) return null; // inconsistent guess at numPlayers - skip this sample

    const pool = unseenCardPool({ players: [], board: [] }, hand);
    const myId = 'sim_me';
    const simPlayers = [{ id: myId, hand: hand.map(c => ({ ...c })), wonCards: [], team: 'UNKNOWN', points: 0 }];

    let cursor = 0;
    for (let i = 1; i < numPlayers; i++) {
        simPlayers.push({
            id: 'sim_opp_' + i,
            hand: pool.slice(cursor, cursor + cardsPerPlayer),
            wonCards: [], team: 'UNKNOWN', points: 0
        });
        cursor += cardsPerPlayer;
    }

    const meSim = simPlayers[0];
    meSim.team = 'BIDDER_TEAM';
    const trumpChoice = getCpuTrumpChoice(meSim, numPlayers);

    const sim = {
        players: simPlayers,
        board: [],
        trumpSuit: trumpChoice.suit,
        calledCards: [...trumpChoice.calls],
        turnIndex: 0
    };

    runPlayout(sim);

    let bidderPoints = 0;
    sim.players.forEach(p => { if (p.team === 'BIDDER_TEAM') bidderPoints += p.points; });
    return bidderPoints;
}

/**
 * Raw hand-strength score - kept as a fast prior/sanity-check alongside the simulated
 * estimate below, so a small or unlucky batch of samples can't send the bid somewhere wild.
 * Never peeks at anyone else's cards or the eventual trump suit, since neither is knowable
 * yet at bidding time.
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
 * The highest amount this CPU is willing to bid this hand. Runs a few full simulated
 * playouts (this hand as bidder, against randomly-dealt opponents, played out with the same
 * heuristic every seat uses) and blends that realistic estimate with the fast static prior,
 * then shades the result down a bit - bidding right up to your own best-case estimate leaves
 * no margin for a single misplay or an unlucky trump split.
 */
function getCpuMaxBid(hand, numPlayers) {
    if (!numPlayers) numPlayers = Math.max(2, Math.round(52 / Math.max(1, hand.length)));

    const staticPrior = MIN_BID + evaluateCpuHandStrength(hand) * 3.2;

    let total = 0;
    let successes = 0;
    for (let s = 0; s < BID_SIM_SAMPLES; s++) {
        try {
            const result = simulateHandAsBidder(hand, numPlayers);
            if (result !== null && !isNaN(result)) { total += result; successes++; }
        } catch (e) { /* skip a bad sample rather than let one failure sink the estimate */ }
    }

    let raw;
    if (successes >= 3) {
        const simEstimate = total / successes;
        raw = simEstimate * 0.75 + staticPrior * 0.25;
    } else {
        raw = staticPrior;
    }

    raw *= 0.92; // bid a bit under our own realistic estimate, not right up to the edge of it

    const capped = Math.max(MIN_BID, Math.min(MAX_BID, raw));
    return Math.floor(capped / 5) * 5;
}

/**
 * Which exact cards this deal cut from the deck (when 52 doesn't divide evenly across
 * `numPlayers`, startDeal() trims a deterministic set down to size). This is public info -
 * anyone applying the same formula from the same player count gets the same answer - so
 * using it isn't peeking at anything hidden, and it's essential: calling a partner card that
 * was cut from this deal entirely can never find a teammate.
 */
function getEvictedCardSet(numPlayers) {
    if (!numPlayers || typeof EVICTION_ORDER === 'undefined') return new Set();
    const cardsPerPlayer = Math.min(13, Math.trunc(52 / numPlayers));
    const totalDealt = cardsPerPlayer * numPlayers;
    const toRemove = Math.max(0, 52 - totalDealt);
    return new Set(EVICTION_ORDER.slice(0, toRemove));
}

/**
 * Trump suit + partner calls for a CPU that won the bid. Trump is whichever suit it holds
 * the most (and highest-value) cards of; partner calls prioritize the strongest ranks it
 * does NOT hold itself, spread across suits, skipping any card this deal doesn't even
 * contain - calling a card already in your own hand, or one that was cut from the deck
 * entirely, can never find a teammate.
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
    const evicted = getEvictedCardSet(numPlayers);
    const calls = [];
    const priorityValues = ['A', 'K', 'Q', 'J', '10'];
    outer:
    for (const v of priorityValues) {
        for (const s of suits) {
            if (calls.length >= allowedCards) break outer;
            const code = `${v}${s}`;
            if (evicted.has(code)) continue; // doesn't exist in this deal at all
            if (!ownSet.has(code) && calls.indexOf(code) === -1) calls.push(code);
        }
    }
    // Extremely unlikely (would need most of A/K/Q/J/10 across all suits owned or evicted),
    // but fall back to the full rank list rather than ever call fewer cards than allowed.
    if (calls.length < allowedCards) {
        outerFallback:
        for (let i = values.length - 1; i >= 0; i--) {
            for (const s of suits) {
                if (calls.length >= allowedCards) break outerFallback;
                const code = `${values[i]}${s}`;
                if (evicted.has(code) || ownSet.has(code) || calls.indexOf(code) !== -1) continue;
                calls.push(code);
            }
        }
    }
    return { suit: bestSuit, calls: calls };
}