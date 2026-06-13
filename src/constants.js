'use strict';

const STATE = {
  READ: 'user/-/state/com.google/read',
  UNREAD: 'user/-/state/com.google/unread',
  STARRED: 'user/-/state/com.google/starred',
  READING_LIST: 'user/-/state/com.google/reading-list',
  BROADCAST: 'user/-/state/com.google/broadcast',
  LIKE: 'user/-/state/com.google/like',
  KEPT_UNREAD: 'user/-/state/com.google/tracking-kept-unread',
  FRSS_MAIN: 'user/-/state/org.freshrss/main',
  FRSS_IMPORTANT: 'user/-/state/org.freshrss/important',
};

module.exports = { STATE };
