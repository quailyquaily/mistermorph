// The worker avatar images, one per logo style in WORKER_AVATAR_STYLES. Kept apart from
// worker-identity.js, which stays free of asset imports.
import aojashin from "../assets/worker-avatars/aojashin.svg";
import bunko from "../assets/worker-avatars/bunko.svg";
import denko from "../assets/worker-avatars/denko.svg";
import night from "../assets/worker-avatars/night.svg";
import paper from "../assets/worker-avatars/paper.svg";
import rinko from "../assets/worker-avatars/rinko.svg";
import suimen from "../assets/worker-avatars/suimen.svg";

const WORKER_AVATAR_URLS = Object.freeze({ aojashin, bunko, denko, night, paper, rinko, suimen });

export function workerAvatarURL(style) {
  return WORKER_AVATAR_URLS[style] || WORKER_AVATAR_URLS.aojashin;
}
