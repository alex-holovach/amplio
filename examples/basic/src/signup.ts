export interface SignUpInput {
  id: string;
  email: string;
  method: "email" | "oauth" | "invite";
}

export async function signUp(input: SignUpInput) {
  return {
    user: { id: input.id, email: input.email },
    method: input.method,
  };
}
