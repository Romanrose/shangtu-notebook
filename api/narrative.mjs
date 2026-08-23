import { proxyNotebookRequest } from "./_proxy.mjs";

export default {
  fetch(request) {
    return proxyNotebookRequest(request, "narrative");
  },
};
