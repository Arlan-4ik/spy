export const LOCATIONS = [
  "🏖️ Пляж","🎬 Кинотеатр","🍕 Пиццерия","✈️ Аэропорт","🎉 Вечеринка",
  "🏫 Школа","🏥 Больница","🎢 Парк аттракционов","🌙 Ночной клуб",
  "🏨 Отель","🛒 Торговый центр","🚢 Корабль","🏟️ Стадион","🐯 Зоопарк"
];

export function randomCode() {
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join("");
}
export function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }