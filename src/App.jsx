import React,{useEffect,useMemo,useState} from "react";
import {
  addDoc,collection,doc,getDoc,onSnapshot,query,serverTimestamp,
  setDoc,updateDoc,where,getDocs
} from "firebase/firestore";
import {db,firebaseConfigured} from "./firebase";
import {LOCATIONS,randomCode,pick} from "./game";

const LS="spy-night-player";
const load=()=>{try{return JSON.parse(localStorage.getItem(LS))||{}}catch{return{}}};
const save=x=>localStorage.setItem(LS,JSON.stringify(x));

export default function App(){
 const [me,setMe]=useState(load());
 const [room,setRoom]=useState(null);
 const [players,setPlayers]=useState([]);
 const [role,setRole]=useState(null);
 const [view,setView]=useState("home");
 const [name,setName]=useState(me.name||"");
 const [code,setCode]=useState("");
 const [error,setError]=useState("");
 const [selected,setSelected]=useState("");
 const [loading,setLoading]=useState(false);

 useEffect(()=>{
   if(!me.roomId)return;
   const unsubRoom=onSnapshot(doc(db,"rooms",me.roomId),s=>{
     if(!s.exists()){setError("Комната не найдена.");return}
     const data={id:s.id,...s.data()}; setRoom(data);
     if(data.phase==="lobby")setView("lobby");
     if(data.phase==="roles")setView("role");
     if(data.phase==="discussion")setView("discussion");
     if(data.phase==="voting")setView("vote");
     if(data.phase==="results")setView("result");
   });
   const q=query(collection(db,"rooms",me.roomId,"players"));
   const unsubPlayers=onSnapshot(q,s=>setPlayers(s.docs.map(d=>({id:d.id,...d.data()}))));
   return()=>{unsubRoom();unsubPlayers()};
 },[me.roomId]);

 useEffect(()=>{
   if(!me.roomId||!me.uid)return;
   const unsub=onSnapshot(doc(db,"rooms",me.roomId,"privateRoles",me.uid),s=>{
     if(s.exists())setRole(s.data());
   });
   return unsub;
 },[me.roomId,me.uid]);

 const host=room?.hostId===me.uid;
 const sorted=useMemo(()=>[...players].sort((a,b)=>(a.joinedAt?.seconds||0)-(b.joinedAt?.seconds||0)),[players]);

 async function createRoom(){
   setError(""); if(!name.trim())return setError("Сначала введи ник.");
   setLoading(true);
   try{
     let roomCode=randomCode();
     const roomRef=doc(collection(db,"rooms"));
     const uid=crypto.randomUUID();
     await setDoc(roomRef,{code:roomCode,hostId:uid,phase:"lobby",round:1,createdAt:serverTimestamp(),location:null,spyId:null});
     await setDoc(doc(roomRef,"players",uid),{name:name.trim(),uid,score:0,joinedAt:serverTimestamp()});
     const identity={uid,name:name.trim(),roomId:roomRef.id,code:roomCode}; save(identity);setMe(identity);setView("lobby");
   }catch(e){setError(e.message)}finally{setLoading(false)}
 }
 async function joinRoom(){
   setError(""); if(!name.trim()||!code.trim())return setError("Введи ник и код.");
   setLoading(true);
   try{
     const snap=await getDocs(query(collection(db,"rooms"),where("code","==",code.trim().toUpperCase())));
     if(snap.empty)throw Error("Комната с таким кодом не найдена.");
     const r=snap.docs[0]; const uid=crypto.randomUUID();
     await setDoc(doc(r.ref,"players",uid),{name:name.trim(),uid,score:0,joinedAt:serverTimestamp()});
     const identity={uid,name:name.trim(),roomId:r.id,code:r.data().code};save(identity);setMe(identity);setView("lobby");
   }catch(e){setError(e.message)}finally{setLoading(false)}
 }
 async function startGame(){
   if(!host||players.length<3)return setError("Нужно минимум 3 игрока.");
   const spy=pick(players),location=pick(LOCATIONS);
   const batch=[];
   for(const p of players){
     const privateRef=doc(db,"rooms",me.roomId,"privateRoles",p.uid);
     batch.push(setDoc(privateRef,p.uid===spy.uid?{isSpy:true,location:null}:{isSpy:false,location}));
   }
   await Promise.all(batch);
   await updateDoc(doc(db,"rooms",me.roomId),{phase:"roles",location,spyId:spy.uid});
 }
 async function goDiscussion(){await updateDoc(doc(db,"rooms",me.roomId),{phase:"discussion"})}
 async function goVote(){await updateDoc(doc(db,"rooms",me.roomId),{phase:"voting"})}
 async function vote(){
   if(!selected)return;
   await setDoc(doc(db,"rooms",me.roomId,"votes",me.uid),{votedFor:selected});
   const votesSnap=await getDocs(collection(db,"rooms",me.roomId,"votes"));
   if(votesSnap.size>=players.length){
     const counts={};votesSnap.forEach(d=>counts[d.data().votedFor]=(counts[d.data().votedFor]||0)+1);
     const winner=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
     const found=winner===room.spyId;
     for(const p of players){
       let add=0;
       if(found&&p.uid!==room.spyId)add=2;
       if(!found&&p.uid===room.spyId)add=3;
       if(add)await updateDoc(doc(db,"rooms",me.roomId,"players",p.uid),{score:(p.score||0)+add});
     }
     await updateDoc(doc(db,"rooms",me.roomId),{phase:"results",caught:found,winnerId:winner});
   }
 }
 async function nextRound(){
   const next=(room.round||1)+1;
   const voteSnap=await getDocs(collection(db,"rooms",me.roomId,"votes"));
   await Promise.all(voteSnap.docs.map(d=>setDoc(d.ref,{votedFor:""})));
   await updateDoc(doc(db,"rooms",me.roomId),{phase:"lobby",round:next,location:null,spyId:null,caught:null,winnerId:null});
   setRole(null);setSelected("");
 }
 function leave(){localStorage.removeItem(LS);location.reload()}

 if(!firebaseConfigured)return <Setup/>;

 return <div className="app">
  <header><div className="logo">🕵️ SPY NIGHT</div><div className="pill">REALTIME</div></header>
  {error&&<div className="error">{error}<button onClick={()=>setError("")}>×</button></div>}

  {view==="home"&&<section className="hero">
    <span className="eyebrow">DISCORD EVENT</span><h1>Найди шпиона,<br/><em>если сможешь.</em></h1>
    <p>Заходите на сайт, а общайтесь в Discord. Роли и голосование синхронизируются у всех игроков в реальном времени.</p>
    <input value={name} onChange={e=>setName(e.target.value)} placeholder="Твой Discord-ник"/>
    <div className="actions"><button className="primary" onClick={createRoom} disabled={loading}>Создать комнату</button><button className="secondary" onClick={()=>setView("join")}>Войти по коду</button></div>
  </section>}

  {view==="join"&&<section className="card narrow"><button className="back" onClick={()=>setView("home")}>← назад</button><span className="eyebrow">ВОЙТИ</span><h2>В комнату</h2><input value={name} onChange={e=>setName(e.target.value)} placeholder="Discord-ник"/><input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="Код комнаты" maxLength="5"/><button className="primary full" onClick={joinRoom}>Войти</button></section>}

  {view==="lobby"&&room&&<section className="card"><div className="top"><div><span className="eyebrow">КОМНАТА</span><h2>{room.code}</h2></div><button className="secondary" onClick={()=>navigator.clipboard?.writeText(room.code)}>Копировать</button></div><p>Кинь код в Discord и жди остальных.</p><div className="players">{sorted.map(p=><div className="player" key={p.uid}>🟢 {p.name}{p.uid===room.hostId?" · host":""}</div>)}</div>{host&&<button className="primary full" onClick={startGame}>Начать игру</button>} {!host&&<div className="waiting">Ждём, пока создатель запустит игру…</div>}</section>}

  {view==="role"&&<section className="card center"><span className="eyebrow">ТВОЯ РОЛЬ · РАУНД {room?.round}</span><div className="big">{role?.isSpy?"🕵️":"📍"}</div><h2>{role?.isSpy?"Ты — ШПИОН":"Ты — мирный игрок"}</h2><p>{role?.isSpy?"Ты не знаешь локацию. По вопросам попробуй понять, где все находятся.":"У всех мирных одна локация. Не называй её напрямую и попробуй вычислить шпиона."}</p>{role?.isSpy?<div className="hiddenPlace">Локация скрыта</div>:<div className="location">{role?.location}</div>}<button className="primary full" onClick={goDiscussion}>Я запомнил</button></section>}

  {view==="discussion"&&<section className="card"><span className="eyebrow">ОБСУЖДЕНИЕ</span><h2>Переходим в Discord</h2><p>Теперь общайтесь в войсе. Задавайте вопросы друг другу и пытайтесь вычислить шпиона.</p><div className="tips"><div>🎙️ Общайтесь в Discord</div><div>🧠 Не называйте локацию напрямую</div><div>🕵️ Следите за подозрительными ответами</div></div>{host&&<button className="primary full" onClick={goVote}>Перейти к голосованию</button>}{!host&&<div className="waiting">Ждём ведущего…</div>}</section>}

  {view==="vote"&&<section className="card"><span className="eyebrow">ГОЛОСОВАНИЕ</span><h2>Кто шпион?</h2><p>Выбери одного игрока.</p><div className="voteList">{players.map(p=><button className={"vote "+(selected===p.uid?"selected":"")} key={p.uid} onClick={()=>setSelected(p.uid)}>👤 {p.name}</button>)}</div><button className="primary full" disabled={!selected} onClick={vote}>Проголосовать</button><small>Результат появится, когда проголосуют все.</small></section>}

  {view==="result"&&<section className="card center"><span className="eyebrow">РАУНД {room?.round} · РЕЗУЛЬТАТ</span><div className="big">🏆</div><h2>{room?.caught?"Шпион найден!":"Шпион не найден!"}</h2><p>{room?.caught?"Игроки правильно вычислили шпиона.":"Большинство проголосовало не за шпиона."}</p><div className="scoreboard">{[...players].sort((a,b)=>(b.score||0)-(a.score||0)).map((p,i)=><div key={p.uid}><span>{i+1}. {p.name}</span><b>{p.score||0}</b></div>)}</div>{host&&<button className="primary full" onClick={nextRound}>Следующий раунд</button>}</section>}

  {me.roomId&&<button className="leave" onClick={leave}>Выйти из комнаты</button>}
 </div>
}

function Setup(){return <div className="app"><header><div className="logo">🕵️ SPY NIGHT</div></header><section className="card"><span className="eyebrow">НАСТРОЙКА</span><h2>Подключи Firebase</h2><p>Скопируй <b>.env.example</b> в <b>.env.local</b> и вставь настройки своего Firebase-проекта. После этого запусти проект снова.</p><pre>npm install{"\n"}npm run dev</pre></section></div>}