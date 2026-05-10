declare module 'authenticate-pam' {
  interface PamAuthenticateCallback {
    (err: Error | null): void;
  }

  function authenticate(
    username: string,
    password: string,
    callback: PamAuthenticateCallback
  ): void;

  export = { authenticate };
}