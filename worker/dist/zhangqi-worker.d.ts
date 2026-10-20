declare const worker: { fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> };
export default worker;
