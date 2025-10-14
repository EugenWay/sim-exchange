export type Side = "BUY" | "SELL";

export type LimitOrder = {
  id: string;
  agent: number;
  symbol: string;
  side: Side;
  price: number; // int cents
  qty: number; // remaining qty
  ts: number; // ns
};

export type L2Level = [price: number, qty: number];

export type TradeEvent = {
  ts: number; // ns
  symbol: string;
  price: number;
  qty: number;
  maker: number;
  taker: number;
  makerSide: Side; // какая сторона стояла в книге
};
