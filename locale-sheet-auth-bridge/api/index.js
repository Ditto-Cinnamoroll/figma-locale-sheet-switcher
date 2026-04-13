import { handleNodeRequest } from "../server.js";

export default async function handler(req, res) {
  return handleNodeRequest(req, res);
}
