import React, { useEffect, useMemo, useState } from "react";

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { db, firebaseConfigured } from "./firebase";

import { LOCATIONS, ITEMS, randomCode, pick, randomRoundType } from "./game";

const LS = "spy-night-player";

// ========================================
// LOCAL STORAGE
// ========================================

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {};
  } catch {
    return {};
  }
};

const save = (data) => {
  localStorage.setItem(LS, JSON.stringify(data));
};

// ========================================
// APP
// ========================================

export default function App() {
  const [me, setMe] = useState(load());

  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);

  const [role, setRole] = useState(null);

  const [view, setView] = useState("home");

  const [name, setName] = useState(me.name || "");

  const [code, setCode] = useState("");

  const [error, setError] = useState("");

  const [selected, setSelected] = useState("");

  const [loading, setLoading] = useState(false);

  const [hasVoted, setHasVoted] = useState(false);

  const [kicked, setKicked] = useState(false);

  // ========================================
  // ROOM LISTENER
  // ========================================

  useEffect(() => {
    if (!me.roomId) return;

    const roomRef = doc(db, "rooms", me.roomId);

    const unsubRoom = onSnapshot(
      roomRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setError("Комната не найдена.");
          return;
        }

        const data = {
          id: snapshot.id,
          ...snapshot.data(),
        };

        setRoom(data);

        if (data.phase === "lobby") {
          setView("lobby");
        }

        if (data.phase === "roles") {
          setView("role");
        }

        if (data.phase === "discussion") {
          setView("discussion");
        }

        if (data.phase === "voting") {
          setView("vote");
        }

        if (data.phase === "results") {
          setView("result");
        }
      },
      (err) => {
        setError(err.message);
      },
    );

    // PLAYERS
    const playersQuery = query(collection(db, "rooms", me.roomId, "players"));

    const unsubPlayers = onSnapshot(playersQuery, (snapshot) => {
      const list = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      setPlayers(list);

      const stillHere = list.some((player) => player.uid === me.uid);

      if (me.uid && !stillHere) {
        setKicked(true);

        localStorage.removeItem(LS);
      }
    });

    return () => {
      unsubRoom();
      unsubPlayers();
    };
  }, [me.roomId, me.uid]);

  // ========================================
  // PRIVATE ROLE
  // ========================================

  useEffect(() => {
    if (!me.roomId || !me.uid) {
      return;
    }

    const roleRef = doc(db, "rooms", me.roomId, "privateRoles", me.uid);

    const unsub = onSnapshot(roleRef, (snapshot) => {
      if (snapshot.exists()) {
        setRole(snapshot.data());
      }
    });

    return unsub;
  }, [me.roomId, me.uid]);

  // ========================================
  // CHECK VOTE
  // ========================================

  useEffect(() => {
    async function checkVote() {
      if (!me.roomId || !me.uid) {
        return;
      }

      try {
        const voteRef = doc(db, "rooms", me.roomId, "votes", me.uid);

        const snapshot = await getDoc(voteRef);

        if (snapshot.exists() && snapshot.data()?.votedFor) {
          setHasVoted(true);
        } else {
          setHasVoted(false);
        }
      } catch (err) {
        console.error(err);
      }
    }

    checkVote();
  }, [me.roomId, me.uid, view]);

  // ========================================
  // HOST
  // ========================================

  const host = room?.hostId === me.uid;

  // ========================================
  // SORT PLAYERS
  // ========================================

  const sorted = useMemo(() => {
    return [...players].sort(
      (a, b) => (a.joinedAt?.seconds || 0) - (b.joinedAt?.seconds || 0),
    );
  }, [players]);

  // ========================================
  // CREATE ROOM
  // ========================================

  async function createRoom() {
    setError("");

    if (!name.trim()) {
      return setError("Сначала введи ник.");
    }

    setLoading(true);

    try {
      const roomCode = randomCode();

      const roomRef = doc(collection(db, "rooms"));

      const uid = crypto.randomUUID();

      await setDoc(roomRef, {
        code: roomCode,

        hostId: uid,

        phase: "lobby",

        round: 1,

        createdAt: serverTimestamp(),

        roundType: null,

        answer: null,

        spyId: null,

        caught: null,

        winnerId: null,
      });

      await setDoc(doc(roomRef, "players", uid), {
        name: name.trim(),

        uid,

        score: 0,

        joinedAt: serverTimestamp(),
      });

      const identity = {
        uid,

        name: name.trim(),

        roomId: roomRef.id,

        code: roomCode,
      };

      save(identity);

      setMe(identity);

      setView("lobby");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ========================================
  // JOIN ROOM
  // ========================================

  async function joinRoom() {
    setError("");

    if (!name.trim() || !code.trim()) {
      return setError("Введи ник и код.");
    }

    setLoading(true);

    try {
      const snapshot = await getDocs(
        query(
          collection(db, "rooms"),
          where("code", "==", code.trim().toUpperCase()),
        ),
      );

      if (snapshot.empty) {
        throw Error("Комната с таким кодом не найдена.");
      }

      const roomDoc = snapshot.docs[0];

      const roomData = roomDoc.data();

      if (roomData.phase !== "lobby") {
        throw Error("Игра уже началась. Дождись следующего раунда.");
      }

      const uid = crypto.randomUUID();

      await setDoc(doc(roomDoc.ref, "players", uid), {
        name: name.trim(),

        uid,

        score: 0,

        joinedAt: serverTimestamp(),
      });

      const identity = {
        uid,

        name: name.trim(),

        roomId: roomDoc.id,

        code: roomData.code,
      };

      save(identity);

      setMe(identity);

      setView("lobby");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ========================================
  // START GAME
  // ========================================

  async function startGame() {
    if (!host) return;

    if (players.length < 3) {
      return setError("Нужно минимум 3 игрока.");
    }

    try {
      setLoading(true);

      // Выбираем тип раунда
      const roundType = randomRoundType();

      // Выбираем ответ
      const answer = roundType === "location" ? pick(LOCATIONS) : pick(ITEMS);

      // Выбираем шпиона
      const spy = pick(players);

      // Создаём приватные роли
      const promises = [];

      for (const player of players) {
        const privateRef = doc(
          db,
          "rooms",
          me.roomId,
          "privateRoles",
          player.uid,
        );

        const data =
          player.uid === spy.uid
            ? {
                isSpy: true,

                roundType,

                answer: null,
              }
            : {
                isSpy: false,

                roundType,

                answer,
              };

        promises.push(setDoc(privateRef, data));
      }

      await Promise.all(promises);

      // Обновляем комнату
      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "roles",

        roundType,

        answer,

        spyId: spy.uid,

        caught: null,

        winnerId: null,
      });

      setHasVoted(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ========================================
  // GO DISCUSSION
  // ========================================

  async function goDiscussion() {
    if (!role) {
      return setError("Роль ещё загружается.");
    }

    try {
      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "discussion",
      });
    } catch (err) {
      setError(err.message);
    }
  }

  // ========================================
  // GO VOTE
  // ========================================

  async function goVote() {
    if (!host) return;

    try {
      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "voting",
      });

      setSelected("");

      setHasVoted(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // ========================================
  // VOTE
  // ========================================

  async function vote() {
    if (!selected) return;

    if (selected === me.uid) {
      return setError("Нельзя голосовать за самого себя.");
    }

    if (hasVoted) {
      return setError("Ты уже проголосовал.");
    }

    try {
      setLoading(true);

      await setDoc(doc(db, "rooms", me.roomId, "votes", me.uid), {
        votedFor: selected,

        votedAt: serverTimestamp(),
      });

      setHasVoted(true);

      const votesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "votes"),
      );

      if (votesSnapshot.size >= players.length) {
        const counts = {};

        votesSnapshot.forEach((voteDoc) => {
          const votedFor = voteDoc.data().votedFor;

          if (!votedFor) return;

          counts[votedFor] = (counts[votedFor] || 0) + 1;
        });

        const sortedVotes = Object.entries(counts).sort((a, b) => b[1] - a[1]);

        if (!sortedVotes.length) {
          return;
        }

        const winner = sortedVotes[0][0];

        const found = winner === room.spyId;

        // Очки
        for (const player of players) {
          let add = 0;

          // Мирные нашли шпиона
          if (found && player.uid !== room.spyId) {
            add = 2;
          }

          // Шпион остался незамеченным
          if (!found && player.uid === room.spyId) {
            add = 3;
          }

          if (add) {
            await updateDoc(
              doc(db, "rooms", me.roomId, "players", player.uid),
              {
                score: (player.score || 0) + add,
              },
            );
          }
        }

        await updateDoc(doc(db, "rooms", me.roomId), {
          phase: "results",

          caught: found,

          winnerId: winner,
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ========================================
  // NEXT ROUND
  // ========================================

  async function nextRound() {
    if (!host) return;

    try {
      const nextRound = (room.round || 1) + 1;

      // Удаляем старые роли
      const rolesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "privateRoles"),
      );

      await Promise.all(rolesSnapshot.docs.map((item) => deleteDoc(item.ref)));

      // Удаляем старые голоса
      const votesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "votes"),
      );

      await Promise.all(votesSnapshot.docs.map((item) => deleteDoc(item.ref)));

      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "lobby",

        round: nextRound,

        roundType: null,

        answer: null,

        spyId: null,

        caught: null,

        winnerId: null,
      });

      setRole(null);

      setSelected("");

      setHasVoted(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // ========================================
  // REMOVE PLAYER
  // ========================================

  async function removePlayer(player) {
    if (!host) return;

    if (player.uid === me.uid) {
      return setError("Нельзя удалить самого себя.");
    }

    const confirmed = window.confirm(
      `Удалить игрока "${player.name}" из комнаты?`,
    );

    if (!confirmed) return;

    try {
      await deleteDoc(doc(db, "rooms", me.roomId, "players", player.uid));

      await deleteDoc(doc(db, "rooms", me.roomId, "privateRoles", player.uid));

      await deleteDoc(doc(db, "rooms", me.roomId, "votes", player.uid));
    } catch (err) {
      setError(err.message);
    }
  }

  // ========================================
  // LEAVE
  // ========================================

  async function leave() {
    const confirmed = window.confirm("Точно хочешь выйти из комнаты?");

    if (!confirmed) return;

    try {
      if (me.roomId && me.uid && !host) {
        await deleteDoc(doc(db, "rooms", me.roomId, "players", me.uid));
      }

      localStorage.removeItem(LS);

      window.location.reload();
    } catch (err) {
      setError(err.message);
    }
  }

  // ========================================
  // KICKED
  // ========================================

  if (kicked) {
    return (
      <div className="app">
        <header>
          <div className="logo">🕵️ SPY NIGHT</div>
        </header>

        <section className="card center">
          <div className="big">🚫</div>

          <span className="eyebrow">ДОСТУП ЗАКРЫТ</span>

          <h2>Тебя удалили</h2>

          <p>Ведущий удалил тебя из этой комнаты.</p>

          <button
            className="primary full"
            onClick={() => {
              localStorage.removeItem(LS);

              window.location.reload();
            }}
          >
            Вернуться
          </button>
        </section>
      </div>
    );
  }

  // ========================================
  // FIREBASE SETUP
  // ========================================

  if (!firebaseConfigured) {
    return <Setup />;
  }

  // ========================================
  // MAIN
  // ========================================

  return (
    <div className="app">
      {/* HEADER */}

      <header>
        <div className="logo">🕵️ SPY NIGHT</div>

        <div className="pill">REALTIME</div>
      </header>

      {/* ERROR */}

      {error && (
        <div className="error">
          <span>{error}</span>

          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      {/* =================================
          HOME
      ================================= */}

      {view === "home" && (
        <section className="hero">
          <span className="eyebrow">DISCORD EVENT</span>

          <h1>
            Найди шпиона,
            <br />
            <em>если сможешь.</em>
          </h1>

          <p>
            Заходите на сайт, а общайтесь в Discord. Роли, голосование и
            результаты синхронизируются у всех игроков в реальном времени.
          </p>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Твой Discord-ник"
          />

          <div className="actions">
            <button className="primary" onClick={createRoom} disabled={loading}>
              {loading ? "Создание..." : "Создать комнату"}
            </button>

            <button className="secondary" onClick={() => setView("join")}>
              Войти по коду
            </button>
          </div>
        </section>
      )}

      {/* =================================
          JOIN
      ================================= */}

      {view === "join" && (
        <section className="card narrow">
          <button className="back" onClick={() => setView("home")}>
            ← назад
          </button>

          <span className="eyebrow">ВОЙТИ</span>

          <h2>В комнату</h2>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Discord-ник"
          />

          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Код комнаты"
            maxLength={5}
          />

          <button
            className="primary full"
            onClick={joinRoom}
            disabled={loading}
          >
            {loading ? "Вход..." : "Войти"}
          </button>
        </section>
      )}

      {/* =================================
          LOBBY
      ================================= */}

      {view === "lobby" && room && (
        <section className="card">
          <div className="top">
            <div>
              <span className="eyebrow">КОМНАТА</span>

              <h2>{room.code}</h2>
            </div>

            <button
              className="secondary"
              onClick={() => navigator.clipboard?.writeText(room.code)}
            >
              Копировать
            </button>
          </div>

          <p>Кинь код в Discord и жди остальных.</p>

          <div className="players">
            {sorted.map((player) => (
              <div className="player" key={player.uid}>
                <span>
                  🟢 {player.name}
                  {player.uid === room.hostId && " · host"}
                </span>

                {host && player.uid !== me.uid && (
                  <button
                    className="remove-player"
                    onClick={() => removePlayer(player)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          {host ? (
            <button
              className="primary full"
              onClick={startGame}
              disabled={loading || players.length < 3}
            >
              {players.length < 3 ? "Нужно минимум 3 игрока" : "Начать игру"}
            </button>
          ) : (
            <div className="waiting">Ждём, пока создатель запустит игру…</div>
          )}
        </section>
      )}

      {/* =================================
          ROLE
      ================================= */}

      {view === "role" && (
        <section className="card center">
          <span className="eyebrow">
            РАУНД {room?.round} ·{" "}
            {role?.roundType === "item" ? "ПРЕДМЕТ" : "ЛОКАЦИЯ"}
          </span>

          <div className="big">
            {role?.isSpy ? "🕵️" : role?.roundType === "item" ? "🎒" : "📍"}
          </div>

          <h2>
            {role?.isSpy
              ? "Ты — ШПИОН"
              : role?.roundType === "item"
                ? "Твой предмет"
                : "Твоя локация"}
          </h2>

          <p>
            {role?.isSpy
              ? role?.roundType === "item"
                ? "Ты не знаешь предмет. Слушай ответы других игроков и попробуй понять, что это за вещь."
                : "Ты не знаешь локацию. Слушай ответы других игроков и попробуй понять, где все находятся."
              : role?.roundType === "item"
                ? "У всех мирных один и тот же предмет. Не называй его напрямую и попробуй вычислить шпиона."
                : "У всех мирных одна и та же локация. Не называй её напрямую и попробуй вычислить шпиона."}
          </p>

          {/* SPY */}

          {role?.isSpy ? (
            <div className="hiddenPlace">
              🕵️
              <strong>Ты — ШПИОН</strong>
              <span>
                {role?.roundType === "item"
                  ? "Предмет скрыт"
                  : "Локация скрыта"}
              </span>
            </div>
          ) : (
            <div className="location">
              {role?.roundType === "item" ? "🎒" : "📍"}

              <strong>{role?.answer}</strong>
            </div>
          )}

          <button className="primary full" onClick={goDiscussion}>
            Я запомнил →
          </button>
        </section>
      )}

      {/* =================================
          DISCUSSION
      ================================= */}

      {view === "discussion" && (
        <section className="card">
          <span className="eyebrow">ОБСУЖДЕНИЕ</span>

          <h2>Переходим в Discord</h2>

          <p>
            Теперь начинается самое интересное. Общайтесь, задавайте вопросы и
            пытайтесь понять, кто здесь шпион.
          </p>

          <div className="tips">
            <div>🎙️ Общайтесь в Discord</div>

            <div>🧠 Не называйте локацию или предмет напрямую</div>

            <div>👀 Следите за подозрительными ответами</div>

            <div>🕵️ Шпион пытается не спалиться</div>
          </div>

          {host ? (
            <button className="primary full" onClick={goVote}>
              Перейти к голосованию
            </button>
          ) : (
            <div className="waiting">Ждём ведущего…</div>
          )}
        </section>
      )}

      {/* =================================
          VOTE
      ================================= */}

      {view === "vote" && (
        <section className="card">
          <span className="eyebrow">ГОЛОСОВАНИЕ</span>

          <h2>Кто шпион?</h2>

          <p>Выбери одного игрока, которого считаешь шпионом.</p>

          <div className="voteList">
            {players
              .filter((player) => player.uid !== me.uid)
              .map((player) => (
                <button
                  className={
                    "vote " + (selected === player.uid ? "selected" : "")
                  }
                  key={player.uid}
                  onClick={() => !hasVoted && setSelected(player.uid)}
                  disabled={hasVoted}
                >
                  👤 {player.name}
                </button>
              ))}
          </div>

          <button
            className="primary full"
            disabled={!selected || hasVoted || loading}
            onClick={vote}
          >
            {hasVoted
              ? "✓ Ты проголосовал"
              : loading
                ? "Отправка..."
                : "Проголосовать"}
          </button>

          <small>
            {hasVoted
              ? "Ждём остальных игроков."
              : "Результат появится, когда проголосуют все."}
          </small>
        </section>
      )}

      {/* =================================
          RESULTS
      ================================= */}

      {view === "result" && (
        <section className="card center">
          <span className="eyebrow">
            РАУНД {room?.round}
            {" · "}
            РЕЗУЛЬТАТ
          </span>

          <div className="big">{room?.caught ? "🎯" : "🕵️"}</div>

          <h2>{room?.caught ? "Шпион найден!" : "Шпион не найден!"}</h2>

          <p>
            {room?.caught
              ? "Мирные игроки смогли вычислить шпиона."
              : "Шпион смог запутать игроков и остался незамеченным."}
          </p>

          {/* ANSWER */}

          <div className="result-answer">
            <span>
              {room?.roundType === "item"
                ? "🎒 Был предмет"
                : "📍 Была локация"}
            </span>

            <strong>{room?.answer}</strong>
          </div>

          <div className="scoreboard">
            {[...players]
              .sort((a, b) => (b.score || 0) - (a.score || 0))
              .map((player, index) => (
                <div key={player.uid}>
                  <span>
                    {index + 1}. {player.name}
                  </span>

                  <b>{player.score || 0}</b>
                </div>
              ))}
          </div>

          {host && (
            <button className="primary full" onClick={nextRound}>
              Следующий раунд →
            </button>
          )}
        </section>
      )}

      {/* =================================
          LEAVE
      ================================= */}

      {me.roomId && (
        <button className="leave" onClick={leave}>
          Выйти из комнаты
        </button>
      )}
    </div>
  );
}

// ========================================
// FIREBASE SETUP
// ========================================

function Setup() {
  return (
    <div className="app">
      <header>
        <div className="logo">🕵️ SPY NIGHT</div>
      </header>

      <section className="card">
        <span className="eyebrow">НАСТРОЙКА</span>

        <h2>Подключи Firebase</h2>

        <p>
          Скопируй <b>.env.example</b> в <b>.env.local</b> и вставь настройки
          Firebase.
        </p>

        <pre>
          {`npm install
npm run dev`}
        </pre>
      </section>
    </div>
  );
}
