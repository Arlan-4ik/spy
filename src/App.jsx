import React, { useEffect, useMemo, useState } from "react";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { db, firebaseConfigured } from "./firebase";

import { LOCATIONS, ITEMS, randomCode, pick } from "./game";

const LS = "spy-night-player";

function loadPlayer() {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {};
  } catch {
    return {};
  }
}

function savePlayer(data) {
  localStorage.setItem(LS, JSON.stringify(data));
}

export default function App() {
  const [me, setMe] = useState(loadPlayer());

  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);

  const [role, setRole] = useState(null);

  const [view, setView] = useState("home");

  const [name, setName] = useState(me.name || "");
  const [code, setCode] = useState("");

  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");

  const [loading, setLoading] = useState(false);

  const [showInfo, setShowInfo] = useState(true);

  /* =========================================
     ROOM LISTENER
  ========================================= */

  useEffect(() => {
    if (!me.roomId) return;

    const roomRef = doc(db, "rooms", me.roomId);

    const unsubscribeRoom = onSnapshot(
      roomRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setError("Комната больше не существует.");
          return;
        }

        const data = {
          id: snapshot.id,
          ...snapshot.data(),
        };

        setRoom(data);

        /*
          ВАЖНО:
          Роль больше не исчезает при переходе
          discussion / voting.

          Информация игрока находится отдельно
          в карточке справа.
        */

        if (data.phase === "lobby") {
          setView("lobby");
        }

        if (data.phase === "roles" || data.phase === "discussion") {
          setView("discussion");
        }

        if (data.phase === "voting") {
          setView("vote");
        }

        if (data.phase === "results") {
          setView("result");
        }
      },
      (error) => {
        setError(error.message);
      },
    );

    const playersQuery = query(collection(db, "rooms", me.roomId, "players"));

    const unsubscribePlayers = onSnapshot(playersQuery, (snapshot) => {
      setPlayers(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        })),
      );
    });

    return () => {
      unsubscribeRoom();
      unsubscribePlayers();
    };
  }, [me.roomId]);

  /* =========================================
     PRIVATE ROLE LISTENER
  ========================================= */

  useEffect(() => {
    if (!me.roomId || !me.uid) return;

    const roleRef = doc(db, "rooms", me.roomId, "privateRoles", me.uid);

    const unsubscribe = onSnapshot(roleRef, (snapshot) => {
      if (snapshot.exists()) {
        setRole(snapshot.data());
      }
    });

    return unsubscribe;
  }, [me.roomId, me.uid]);

  /* =========================================
     HELPERS
  ========================================= */

  const host = room?.hostId === me.uid;

  const sortedPlayers = useMemo(() => {
    return [...players].sort(
      (a, b) => (a.joinedAt?.seconds || 0) - (b.joinedAt?.seconds || 0),
    );
  }, [players]);

  function clearError() {
    setError("");
  }

  /* =========================================
     CREATE ROOM
  ========================================= */

  async function createRoom() {
    setError("");

    if (!name.trim()) {
      setError("Сначала введи свой ник.");
      return;
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

        location: null,

        item: null,

        spyId: null,

        caught: null,

        winnerId: null,

        createdAt: serverTimestamp(),
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

      savePlayer(identity);

      setMe(identity);

      setView("lobby");
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /* =========================================
     JOIN ROOM
  ========================================= */

  async function joinRoom() {
    setError("");

    if (!name.trim() || !code.trim()) {
      setError("Введи ник и код комнаты.");
      return;
    }

    setLoading(true);

    try {
      const roomsQuery = query(
        collection(db, "rooms"),
        where("code", "==", code.trim().toUpperCase()),
      );

      const snapshot = await getDocs(roomsQuery);

      if (snapshot.empty) {
        throw new Error("Комната с таким кодом не найдена.");
      }

      const roomDoc = snapshot.docs[0];

      if (roomDoc.data().phase !== "lobby") {
        throw new Error("Игра уже началась. Подключиться нельзя.");
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

        code: roomDoc.data().code,
      };

      savePlayer(identity);

      setMe(identity);

      setView("lobby");
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /* =========================================
     START ROUND
  ========================================= */

  async function startGame() {
    if (!host) return;

    if (players.length < 3) {
      setError("Для начала игры нужно минимум 3 игрока.");
      return;
    }

    setLoading(true);

    try {
      /*
        Рандомная локация
      */

      const location = pick(LOCATIONS);

      /*
        Рандомный предмет
      */

      const item = pick(ITEMS);

      /*
        Рандомный шпион
      */

      const spy = pick(players);

      /*
        Каждому игроку выдаём
        персональную информацию
      */

      const promises = players.map((player) => {
        const privateRef = doc(
          db,
          "rooms",
          me.roomId,
          "privateRoles",
          player.uid,
        );

        /*
          Шпион:
          знает что он шпион,
          но НЕ знает локацию и предмет.
        */

        if (player.uid === spy.uid) {
          return setDoc(privateRef, {
            isSpy: true,

            location: null,

            item: null,

            round: room?.round || 1,
          });
        }

        /*
          Мирный:
          знает локацию и предмет.
        */

        return setDoc(privateRef, {
          isSpy: false,

          location,

          item,

          round: room?.round || 1,
        });
      });

      await Promise.all(promises);

      /*
        Очищаем старые голоса
      */

      const votesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "votes"),
      );

      await Promise.all(votesSnapshot.docs.map((vote) => deleteDoc(vote.ref)));

      /*
        Запускаем раунд
      */

      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "roles",

        location,

        item,

        spyId: spy.uid,

        caught: null,

        winnerId: null,
      });

      setSelected("");

      setShowInfo(true);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /* =========================================
     GO DISCUSSION
  ========================================= */

  async function goDiscussion() {
    if (!host) return;

    await updateDoc(doc(db, "rooms", me.roomId), {
      phase: "discussion",
    });
  }

  /* =========================================
     GO VOTE
  ========================================= */

  async function goVote() {
    if (!host) return;

    await updateDoc(doc(db, "rooms", me.roomId), {
      phase: "voting",
    });
  }

  /* =========================================
     VOTE
  ========================================= */

  async function vote() {
    if (!selected) {
      setError("Сначала выбери игрока.");
      return;
    }

    if (!room || room.phase !== "voting") {
      return;
    }

    setLoading(true);

    try {
      await setDoc(doc(db, "rooms", me.roomId, "votes", me.uid), {
        votedFor: selected,

        playerId: me.uid,

        createdAt: serverTimestamp(),
      });

      /*
        Проверяем количество голосов
      */

      const votesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "votes"),
      );

      /*
        Пока проголосовали не все —
        ничего не заканчиваем.
      */

      if (votesSnapshot.size < players.length) {
        setLoading(false);
        return;
      }

      /*
        Считаем голоса
      */

      const counts = {};

      votesSnapshot.forEach((voteDoc) => {
        const votedFor = voteDoc.data().votedFor;

        if (!votedFor) return;

        counts[votedFor] = (counts[votedFor] || 0) + 1;
      });

      const sortedVotes = Object.entries(counts).sort((a, b) => b[1] - a[1]);

      if (!sortedVotes.length) {
        setLoading(false);
        return;
      }

      /*
        Игрок с максимальным количеством
        голосов
      */

      const winnerId = sortedVotes[0][0];

      const found = winnerId === room.spyId;

      /*
        Начисляем очки
      */

      for (const player of players) {
        let points = 0;

        /*
          Мирные нашли шпиона
        */

        if (found && player.uid !== room.spyId) {
          points = 2;
        }

        /*
          Шпион победил
        */

        if (!found && player.uid === room.spyId) {
          points = 3;
        }

        if (points > 0) {
          await updateDoc(doc(db, "rooms", me.roomId, "players", player.uid), {
            score: (player.score || 0) + points,
          });
        }
      }

      /*
        Показываем результат
      */

      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "results",

        caught: found,

        winnerId,
      });
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /* =========================================
     NEXT ROUND
  ========================================= */

  async function nextRound() {
    if (!host) return;

    setLoading(true);

    try {
      /*
        Удаляем старые голоса
      */

      const votesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "votes"),
      );

      await Promise.all(votesSnapshot.docs.map((vote) => deleteDoc(vote.ref)));

      /*
        Удаляем старые роли
      */

      const rolesSnapshot = await getDocs(
        collection(db, "rooms", me.roomId, "privateRoles"),
      );

      await Promise.all(
        rolesSnapshot.docs.map((roleDoc) => deleteDoc(roleDoc.ref)),
      );

      const next = (room?.round || 1) + 1;

      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "lobby",

        round: next,

        location: null,

        item: null,

        spyId: null,

        caught: null,

        winnerId: null,
      });

      setRole(null);

      setSelected("");

      setShowInfo(true);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  /* =========================================
     REMOVE PLAYER
  ========================================= */

  async function removePlayer(player) {
    if (!host) return;

    if (player.uid === me.uid) {
      return;
    }

    try {
      await deleteDoc(doc(db, "rooms", me.roomId, "players", player.uid));
    } catch (error) {
      setError(error.message);
    }
  }

  /* =========================================
     LEAVE
  ========================================= */

  function leave() {
    localStorage.removeItem(LS);

    window.location.reload();
  }

  /* =========================================
     PLAYER INFO CARD
  ========================================= */

  function PlayerInfoCard() {
    if (!role || view === "home" || view === "join" || view === "lobby") {
      return null;
    }

    return (
      <aside
        className={"player-info " + (role.isSpy ? "spy-info" : "civilian-info")}
      >
        <div className="player-info-header">
          <div>
            <span className="info-mini">ТВОЯ ИНФОРМАЦИЯ</span>

            <strong>{role.isSpy ? "🔴 ШПИОН" : "🟢 МИРНЫЙ"}</strong>
          </div>

          <button
            className="info-toggle"
            onClick={() => setShowInfo((value) => !value)}
          >
            {showInfo ? "−" : "+"}
          </button>
        </div>

        {showInfo && (
          <div className="player-info-body">
            {role.isSpy ? (
              <>
                <div className="spy-message">
                  <span>🕵️</span>

                  <div>
                    <b>Ты — шпион</b>

                    <small>
                      Твоя задача — понять, где находятся остальные.
                    </small>
                  </div>
                </div>

                <div className="secret-value">
                  <span>📍 ЛОКАЦИЯ</span>

                  <b>???</b>
                </div>

                <div className="secret-value">
                  <span>🎒 ПРЕДМЕТ</span>

                  <b>???</b>
                </div>
              </>
            ) : (
              <>
                <div className="info-value">
                  <span>📍 ЛОКАЦИЯ</span>

                  <b>{role.location || "—"}</b>
                </div>

                <div className="info-value">
                  <span>🎒 ПРЕДМЕТ</span>

                  <b>{role.item || "—"}</b>
                </div>

                <div className="private-label">🔒 Видно только тебе</div>
              </>
            )}
          </div>
        )}
      </aside>
    );
  }

  /* =========================================
     FIREBASE SETUP
  ========================================= */

  if (!firebaseConfigured) {
    return <Setup />;
  }

  /* =========================================
     UI
  ========================================= */

  return (
    <div className="app">
      <header>
        <div className="logo">🕵️ SPY NIGHT</div>

        <div className="pill">REALTIME</div>
      </header>

      {error && (
        <div className="error">
          <span>{error}</span>

          <button onClick={clearError}>×</button>
        </div>
      )}

      <PlayerInfoCard />

      {/* =====================================
          HOME
      ===================================== */}

      {view === "home" && (
        <section className="hero">
          <span className="eyebrow">DISCORD EVENT</span>

          <h1>
            Найди шпиона,
            <br />
            <em>если сможешь.</em>
          </h1>

          <p>
            Заходите на сайт, получайте свою роль и информацию. После этого
            переходим в Discord и пытаемся вычислить шпиона.
          </p>

          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Твой Discord-ник"
            maxLength={24}
          />

          <div className="actions">
            <button className="primary" onClick={createRoom} disabled={loading}>
              {loading ? "Создаём..." : "Создать комнату"}
            </button>

            <button className="secondary" onClick={() => setView("join")}>
              Войти по коду
            </button>
          </div>
        </section>
      )}

      {/* =====================================
          JOIN
      ===================================== */}

      {view === "join" && (
        <section className="card narrow">
          <button className="back" onClick={() => setView("home")}>
            ← назад
          </button>

          <span className="eyebrow">ВОЙТИ</span>

          <h2>В комнату</h2>

          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Discord-ник"
            maxLength={24}
          />

          <div style={{ height: 10 }} />

          <input
            value={code}
            onChange={(event) =>
              setCode(
                event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
              )
            }
            placeholder="Код комнаты"
            maxLength={5}
          />

          <div style={{ height: 12 }} />

          <button
            className="primary full"
            onClick={joinRoom}
            disabled={loading}
          >
            {loading ? "Подключаемся..." : "Войти"}
          </button>
        </section>
      )}

      {/* =====================================
          LOBBY
      ===================================== */}

      {view === "lobby" && room && (
        <section className="card">
          <div className="top">
            <div>
              <span className="eyebrow">КОМНАТА · РАУНД {room.round}</span>

              <h2>{room.code}</h2>
            </div>

            <button
              className="secondary"
              onClick={() => navigator.clipboard?.writeText(room.code)}
            >
              📋 Копировать
            </button>
          </div>

          <p>Кинь код комнаты в Discord и жди остальных игроков.</p>

          <div className="players">
            {sortedPlayers.map((player) => (
              <div className="player" key={player.uid}>
                <span>
                  🟢 {player.name}
                  {player.uid === room.hostId && (
                    <span className="host-label">HOST</span>
                  )}
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
              {players.length < 3
                ? `Нужно ещё ${3 - players.length} игрока`
                : "🕵️ Начать раунд"}
            </button>
          ) : (
            <div className="waiting">
              🕐 Ждём, пока ведущий запустит игру...
            </div>
          )}
        </section>
      )}

      {/* =====================================
          DISCUSSION
      ===================================== */}

      {view === "discussion" && room && (
        <section className="card">
          <span className="eyebrow">РАУНД {room.round} · ОБСУЖДЕНИЕ</span>

          <h2>Кто здесь шпион?</h2>

          <p>
            Теперь переходим в Discord. Ивентеры будут по очереди поднимать
            игроков на трибуну.
          </p>

          <div className="tips">
            <div>
              🎙️ <b>Переходим в Discord</b>
              <br />
              Общаемся и отвечаем на вопросы.
            </div>

            <div>
              🧠 <b>Говори аккуратно</b>
              <br />
              Не называй локацию или предмет напрямую.
            </div>

            <div>
              🕵️ <b>Следи за другими</b>
              <br />
              Шпион пытается понять, где вы находитесь.
            </div>

            <div>
              🎤 <b>Трибуна</b>
              <br />
              Каждый участник должен назвать один факт про локацию или предмет.
            </div>
          </div>

          {host ? (
            <button className="primary full" onClick={goVote}>
              🗳️ Перейти к голосованию
            </button>
          ) : (
            <div className="waiting">🕐 Ждём ведущего...</div>
          )}
        </section>
      )}

      {/* =====================================
          VOTE
      ===================================== */}

      {view === "vote" && room && (
        <section className="card">
          <span className="eyebrow">РАУНД {room.round} · ГОЛОСОВАНИЕ</span>

          <h2>Кто шпион?</h2>

          <p>Выбери одного игрока, которого подозреваешь.</p>

          <div className="voteList">
            {players
              .filter((player) => player.uid !== me.uid)
              .map((player) => (
                <button
                  className={
                    "vote " + (selected === player.uid ? "selected" : "")
                  }
                  key={player.uid}
                  onClick={() => setSelected(player.uid)}
                >
                  👤 {player.name}
                  {selected === player.uid && <span>✓</span>}
                </button>
              ))}
          </div>

          <button
            className="primary full"
            disabled={!selected || loading}
            onClick={vote}
          >
            {loading ? "Считаем голоса..." : "🗳️ Проголосовать"}
          </button>

          <small>Результат появится, когда проголосуют все игроки.</small>
        </section>
      )}

      {/* =====================================
          RESULTS
      ===================================== */}

      {view === "result" && room && (
        <section className="card center">
          <span className="eyebrow">РАУНД {room.round} · РЕЗУЛЬТАТ</span>

          <div className="big">{room.caught ? "🏆" : "💀"}</div>

          <h2>{room.caught ? "Шпион найден!" : "Шпион не найден!"}</h2>

          <p>
            {room.caught
              ? "Мирные правильно вычислили шпиона."
              : "Шпиону удалось остаться незамеченным."}
          </p>

          <div className="result-answer">
            <span>НАСТОЯЩИЙ ШПИОН</span>

            <strong>
              {players.find((player) => player.uid === room.spyId)?.name ||
                "Неизвестно"}
            </strong>
          </div>

          <div className="result-answer">
            <span>ЛОКАЦИЯ</span>

            <strong>📍 {room.location}</strong>
          </div>

          <div className="result-answer">
            <span>ПРЕДМЕТ</span>

            <strong>🎒 {room.item}</strong>
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
            <button
              className="primary full"
              onClick={nextRound}
              disabled={loading}
            >
              {loading ? "Подготавливаем..." : "🔄 Следующий раунд"}
            </button>
          )}

          {!host && (
            <div className="waiting">
              🕐 Ждём ведущего перед следующим раундом...
            </div>
          )}
        </section>
      )}

      {/* =====================================
          LEAVE
      ===================================== */}

      {me.roomId && (
        <button className="leave" onClick={leave}>
          Выйти из комнаты
        </button>
      )}
    </div>
  );
}

/* =========================================
   FIREBASE SETUP SCREEN
========================================= */

function Setup() {
  return (
    <div className="app">
      <header>
        <div className="logo">🕵️ SPY NIGHT</div>
      </header>

      <section className="card">
        <span className="eyebrow">НАСТРОЙКА</span>

        <h2>Подключи Firebase</h2>

        <p>Проверь файл .env.local и настройки Firebase.</p>

        <pre>
          {`npm install
npm run dev`}
        </pre>
      </section>
    </div>
  );
}
