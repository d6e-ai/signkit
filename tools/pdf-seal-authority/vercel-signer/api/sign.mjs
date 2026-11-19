import { createHandler } from '../lib/signer.mjs';

const handler = createHandler();

export default function signHandler(req, res) {
	return handler(req, res);
}
