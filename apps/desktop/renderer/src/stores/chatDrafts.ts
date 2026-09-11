// Drafts remain in memory only, survive route changes, and are cleared at sign-out.
const drafts = new Map<string, string>();
export const chatDrafts = {
  get: (id: string) => drafts.get(id) || '',
  set: (id: string, draft: string) => {
    if (draft) drafts.set(id, draft.slice(0, 32768));
    else drafts.delete(id);
    while (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  },
  clear: () => drafts.clear(),
};
