import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
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
import { LOCATIONS, randomCode, pick } from "./game";

const LS = "spy-night-player";

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {};
  } catch {
    return {};
  }
};

const save = (x) => localStorage.setItem(LS, JSON.stringify(x));

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

  /* =====================================================
     FIREBASE ROOM LISTENER
  ===================================================== */

  useEffect(() => {
    if (!me.roomId) return;

    const unsubRoom = onSnapshot(doc(db, "rooms", me.roomId), (snapshot) => {
      if (!snapshot.exists()) {
        setError("Комната больше не существует.");
        return;
      }

      const data = {
        id: snapshot.id,
        ...snapshot.data(),
      };

      setRoom(data);

      if (data.phase === "lobby") setView("lobby");
      if (data.phase === "roles") setView("role");
      if (data.phase === "discussion") setView("discussion");
      if (data.phase === "voting") setView("vote");
      if (data.phase === "results") setView("result");
    });

    const playersQuery = query(collection(db, "rooms", me.roomId, "players"));

    const unsubPlayers = onSnapshot(playersQuery, (snapshot) => {
      setPlayers(
        snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })),
      );
    });

    return () => {
      unsubRoom();
      unsubPlayers();
    };
  }, [me.roomId]);

  /* =====================================================
     PRIVATE ROLE
  ===================================================== */

  useEffect(() => {
    if (!me.roomId || !me.uid) return;

    const unsub = onSnapshot(
      doc(db, "rooms", me.roomId, "privateRoles", me.uid),
      (snapshot) => {
        if (snapshot.exists()) {
          setRole(snapshot.data());
        }
      },
    );

    return unsub;
  }, [me.roomId, me.uid]);

  const host = room?.hostId === me.uid;

  const sorted = useMemo(
    () =>
      [...players].sort(
        (a, b) => (a.joinedAt?.seconds || 0) - (b.joinedAt?.seconds || 0),
      ),
    [players],
  );

  /* =====================================================
     CREATE ROOM
  ===================================================== */

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
        createdAt: serverTimestamp(),
        location: null,
        spyId: null,
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
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  /* =====================================================
     JOIN ROOM
  ===================================================== */

  async function joinRoom() {
    setError("");

    if (!name.trim() || !code.trim()) {
      setError("Введи ник и код комнаты.");
      return;
    }

    setLoading(true);

    try {
      const snap = await getDocs(
        query(
          collection(db, "rooms"),
          where("code", "==", code.trim().toUpperCase()),
        ),
      );

      if (snap.empty) {
        throw Error("Комната с таким кодом не найдена.");
      }

      const r = snap.docs[0];
      const uid = crypto.randomUUID();

      await setDoc(doc(r.ref, "players", uid), {
        name: name.trim(),
        uid,
        score: 0,
        joinedAt: serverTimestamp(),
      });

      const identity = {
        uid,
        name: name.trim(),
        roomId: r.id,
        code: r.data().code,
      };

      save(identity);
      setMe(identity);
      setView("lobby");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  /* =====================================================
     START GAME
  ===================================================== */

  async function startGame() {
    if (!host) return;

    if (players.length < 3) {
      setError("Нужно минимум 3 игрока.");
      return;
    }

    const spy = pick(players);
    const location = pick(LOCATIONS);

    const writes = [];

    for (const player of players) {
      const privateRef = doc(
        db,
        "rooms",
        me.roomId,
        "privateRoles",
        player.uid,
      );

      writes.push(
        setDoc(
          privateRef,
          player.uid === spy.uid
            ? {
                isSpy: true,
                location: null,
              }
            : {
                isSpy: false,
                location,
              },
        ),
      );
    }

    await Promise.all(writes);

    await updateDoc(doc(db, "rooms", me.roomId), {
      phase: "roles",
      location,
      spyId: spy.uid,
    });
  }

  async function goDiscussion() {
    await updateDoc(doc(db, "rooms", me.roomId), {
      phase: "discussion",
    });
  }

  async function goVote() {
    await updateDoc(doc(db, "rooms", me.roomId), {
      phase: "voting",
    });
  }

  /* =====================================================
     VOTE
  ===================================================== */

  async function vote() {
    if (!selected) return;

    await setDoc(doc(db, "rooms", me.roomId, "votes", me.uid), {
      votedFor: selected,
    });

    const votesSnap = await getDocs(
      collection(db, "rooms", me.roomId, "votes"),
    );

    if (votesSnap.size >= players.length) {
      const counts = {};

      votesSnap.forEach((d) => {
        const votedFor = d.data().votedFor;

        if (!votedFor) return;

        counts[votedFor] = (counts[votedFor] || 0) + 1;
      });

      const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];

      if (!winner) return;

      const found = winner === room.spyId;

      for (const player of players) {
        let add = 0;

        if (found && player.uid !== room.spyId) {
          add = 2;
        }

        if (!found && player.uid === room.spyId) {
          add = 3;
        }

        if (add) {
          await updateDoc(doc(db, "rooms", me.roomId, "players", player.uid), {
            score: (player.score || 0) + add,
          });
        }
      }

      await updateDoc(doc(db, "rooms", me.roomId), {
        phase: "results",
        caught: found,
        winnerId: winner,
      });
    }
  }

  /* =====================================================
     NEXT ROUND
  ===================================================== */

  async function nextRound() {
    const next = (room.round || 1) + 1;

    const voteSnap = await getDocs(collection(db, "rooms", me.roomId, "votes"));

    await Promise.all(
      voteSnap.docs.map((d) =>
        setDoc(d.ref, {
          votedFor: "",
        }),
      ),
    );

    await updateDoc(doc(db, "rooms", me.roomId), {
      phase: "lobby",
      round: next,
      location: null,
      spyId: null,
      caught: null,
      winnerId: null,
    });

    setRole(null);
    setSelected("");
  }

  function leave() {
    localStorage.removeItem(LS);
    window.location.reload();
  }

  /* =====================================================
     SETUP
  ===================================================== */

  if (!firebaseConfigured) {
    return <Setup />;
  }

  return (
    <div className="app">
      {/* =================================================
          HEADER
      ================================================= */}

      <header>
        <div className="logo">🕵️ SPY NIGHT</div>

        <div className="pill">REALTIME</div>
      </header>

      {/* =================================================
          ERROR
      ================================================= */}

      {error && (
        <div className="error">
          <span>{error}</span>

          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      {/* =================================================
          HOME
      ================================================= */}

      {view === "home" && (
        <section className="hero">
          <div className="eyebrow">DISCORD MULTIPLAYER EVENT</div>

          <h1>
            КТО?
            <br />
            <em>ШПИОН</em>
          </h1>

          <p>
            Один из вас — шпион. Остальные знают локацию. Общайтесь в Discord,
            задавайте вопросы и попробуйте вычислить того, кто ничего не знает.
          </p>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Введите Discord-ник"
            maxLength={24}
          />

          <div className="actions">
            <button className="primary" onClick={createRoom} disabled={loading}>
              {loading ? "Создаём..." : "Создать игру →"}
            </button>

            <button className="secondary" onClick={() => setView("join")}>
              Войти по коду
            </button>
          </div>
        </section>
      )}

      {/* =================================================
          JOIN
      ================================================= */}

      {view === "join" && (
        <section className="card narrow">
          <button className="back" onClick={() => setView("home")}>
            ← Назад
          </button>

          <div className="eyebrow">JOIN GAME</div>

          <h2>
            Войти
            <br />в игру
          </h2>

          <p>Получи код комнаты у ведущего и присоединяйся.</p>

          <div style={{ height: 20 }} />

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Discord-ник"
            maxLength={24}
          />

          <div style={{ height: 8 }} />

          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="КОД КОМНАТЫ"
            maxLength={5}
          />

          <div style={{ height: 10 }} />

          <button
            className="primary full"
            onClick={joinRoom}
            disabled={loading}
          >
            {loading ? "Подключение..." : "Войти в комнату →"}
          </button>
        </section>
      )}

      {/* =================================================
          LOBBY
      ================================================= */}

      {view === "lobby" && room && (
        <section className="card">
          <div className="top">
            <div>
              <div className="eyebrow">
                ROUND {String(room.round).padStart(2, "0")}
              </div>

              <h2>{room.code}</h2>
            </div>

            <button
              className="secondary"
              onClick={() => navigator.clipboard?.writeText(room.code)}
            >
              COPY CODE
            </button>
          </div>

          <p>Отправь этот код в Discord. Когда все зайдут — запускай раунд.</p>

          <div className="players">
            {sorted.map((player, index) => (
              <div className="player" key={player.uid}>
                <span>🟢</span>

                <span
                  style={{
                    marginLeft: 8,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {player.name}
                </span>

                {player.uid === room.hostId && (
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "#b7a5ff",
                      fontSize: 9,
                      letterSpacing: ".12em",
                    }}
                  >
                    HOST
                  </span>
                )}
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 12,
              color: "#686b77",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: ".15em",
            }}
          >
            <span>Players</span>

            <span>{players.length} / ∞</span>
          </div>

          {host ? (
            <button
              className="primary full"
              onClick={startGame}
              disabled={players.length < 3}
            >
              {players.length < 3 ? "Нужно ещё игроков" : "Начать раунд →"}
            </button>
          ) : (
            <div className="waiting">● Ведущий готовит игру...</div>
          )}
        </section>
      )}

      {/* =================================================
          ROLE
      ================================================= */}

      {view === "role" && (
        <section className="card center">
          <div className="eyebrow">
            YOUR ROLE · ROUND {String(room?.round || 1).padStart(2, "0")}
          </div>

          <div className="big">{role?.isSpy ? "🕵️" : "📍"}</div>

          <h2>
            {role?.isSpy ? (
              <>
                Ты —
                <br />
                ШПИОН
              </>
            ) : (
              <>
                Ты —
                <br />
                МИРНЫЙ
              </>
            )}
          </h2>

          <p>
            {role?.isSpy
              ? "Ты не знаешь локацию. Слушай ответы остальных и постарайся понять, где вы находитесь."
              : "Все мирные знают одну локацию. Не называй её напрямую и попробуй вычислить шпиона."}
          </p>

          {role?.isSpy ? (
            <div className="hiddenPlace">🔒 ЛОКАЦИЯ СКРЫТА</div>
          ) : (
            <div className="location">📍 {role?.location}</div>
          )}

          <button className="primary full" onClick={goDiscussion}>
            Я ЗАПОМНИЛ →
          </button>
        </section>
      )}

      {/* =================================================
          DISCUSSION
      ================================================= */}

      {view === "discussion" && (
        <section className="card">
          <div className="eyebrow">PHASE 02 · DISCUSSION</div>

          <h2>
            Время
            <br />
            вопросов.
          </h2>

          <p>
            Переходите в Discord. Задавайте друг другу вопросы, отвечайте
            осторожно и ищите того, кто пытается притворяться.
          </p>

          <div className="tips">
            <div>
              🎙️
              <span style={{ marginLeft: 10 }}>Общайтесь в Discord</span>
            </div>

            <div>
              🧠
              <span style={{ marginLeft: 10 }}>
                Не называйте локацию напрямую
              </span>
            </div>

            <div>
              🕵️
              <span style={{ marginLeft: 10 }}>
                Следите за подозрительными ответами
              </span>
            </div>
          </div>

          {host ? (
            <button className="primary full" onClick={goVote}>
              Открыть голосование →
            </button>
          ) : (
            <div className="waiting">● Ведущий управляет раундом</div>
          )}
        </section>
      )}

      {/* =================================================
          VOTING
      ================================================= */}

      {view === "vote" && (
        <section className="card">
          <div className="eyebrow">PHASE 03 · VOTING</div>

          <h2>
            Кто
            <br />
            шпион?
          </h2>

          <p>Выбери одного игрока. После голосования изменить выбор нельзя.</p>

          <div className="voteList">
            {players.map((player, index) => (
              <button
                className={
                  "vote " + (selected === player.uid ? "selected" : "")
                }
                key={player.uid}
                onClick={() => setSelected(player.uid)}
              >
                <span
                  style={{
                    color: "#555762",
                    marginRight: 12,
                    fontSize: 9,
                  }}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                👤 {player.name}
              </button>
            ))}
          </div>

          <button className="primary full" disabled={!selected} onClick={vote}>
            {selected ? "Подтвердить голос →" : "Выбери игрока"}
          </button>

          <small>Результат появится после голосов всех игроков.</small>
        </section>
      )}

      {/* =================================================
          RESULT
      ================================================= */}

      {view === "result" && (
        <section className="card center">
          <div className="eyebrow">
            ROUND {String(room?.round || 1).padStart(2, "0")}
            {" · "}
            RESULTS
          </div>

          <div className="big">{room?.caught ? "🎯" : "🕵️"}</div>

          <h2>
            {room?.caught ? (
              <>
                Шпион
                <br />
                найден.
              </>
            ) : (
              <>
                Шпион
                <br />
                сбежал.
              </>
            )}
          </h2>

          <p>
            {room?.caught
              ? "Большинство правильно вычислило шпиона."
              : "Голосование прошло мимо цели. Шпион получает преимущество."}
          </p>

          <div className="scoreboard">
            {[...players]
              .sort((a, b) => (b.score || 0) - (a.score || 0))
              .map((player, index) => (
                <div key={player.uid}>
                  <span>
                    <span
                      style={{
                        color: "#555762",
                        marginRight: 8,
                      }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>

                    {player.name}
                  </span>

                  <b>{player.score || 0}</b>
                </div>
              ))}
          </div>

          {host ? (
            <button className="primary full" onClick={nextRound}>
              Следующий раунд →
            </button>
          ) : (
            <div className="waiting">● Ждём ведущего</div>
          )}
        </section>
      )}

      {/* =================================================
          LEAVE
      ================================================= */}

      {me.roomId && (
        <button className="leave" onClick={leave}>
          EXIT GAME
        </button>
      )}
    </div>
  );
}

/* =========================================================
   FIREBASE SETUP
========================================================= */

function Setup() {
  return (
    <div className="app">
      <header>
        <div className="logo">🕵️ SPY NIGHT</div>
      </header>

      <section className="card">
        <div className="eyebrow">SYSTEM SETUP</div>

        <h2>
          Firebase
          <br />
          required.
        </h2>

        <p>Подключи Firebase, чтобы запустить realtime-игру.</p>

        <pre>
          {`npm install
npm run dev`}
        </pre>
      </section>
    </div>
  );
}
