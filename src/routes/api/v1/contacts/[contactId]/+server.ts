import { resolveContactApplication } from '$lib/application/contacts/contact-runtime';
import { createContactHttpHandlers } from '$lib/http/contacts';

const handlers = createContactHttpHandlers(resolveContactApplication);

export const PUT = handlers.update;
export const DELETE = handlers.delete;
