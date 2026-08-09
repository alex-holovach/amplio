declare module "express" {
  export interface Request {
    method: string;
    path: string;
    ip?: string;
    route?: { path: string };
    amplio?: import("@useamplio/amplio").Logger;
  }

  export interface Response {
    statusCode: number;
    on(event: "finish", listener: () => void): this;
  }

  export type NextFunction = (error?: unknown) => void;
}

declare global {
  namespace Express {
    interface Request {
      amplio?: import("@useamplio/amplio").Logger;
    }
  }
}

export {};
