export enum MsgType {
  WAKEUP = "WAKEUP",

  LIMIT_ORDER = "LIMIT_ORDER",
  MARKET_ORDER = "MARKET_ORDER",
  CANCEL_ORDER = "CANCEL_ORDER",
  MODIFY_ORDER = "MODIFY_ORDER",

  QUERY_SPREAD = "QUERY_SPREAD",
  QUERY_LAST = "QUERY_LAST",

  MARKET_DATA = "MARKET_DATA",

  ORDER_ACCEPTED = "ORDER_ACCEPTED",
  ORDER_EXECUTED = "ORDER_EXECUTED",
  ORDER_CANCELLED = "ORDER_CANCELLED",

  TRADE = "TRADE",
  ORDER_LOG = "ORDER_LOG",
}

export type AgentId = number;

export type Message<T = any> = {
  to: AgentId;
  from: AgentId;
  type: MsgType;
  at: number; // ns
  body?: T;
};

export type ExecutedBody = {
  symbol: string;
  price: number;
  qty: number;
  role: "MAKER" | "TAKER";
  sideForRecipient: "BUY" | "SELL";
};
