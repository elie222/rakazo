import { ANDROID_APP_STORE_URL } from "@rakazo/contracts/client-build";
import type { APIRoute } from "astro";
import { markdownResponse } from "../agent-content";
import { APP_URL, IOS_APP_URL } from "../site";

// Kept out of agent-content: the edge middleware bundles that file and cannot resolve workspace packages.
const DOWNLOAD_MARKDOWN = `# Download Rakazo

- [macOS](https://rakazo.com/api/download?platform=mac)
- [Windows](https://rakazo.com/api/download?platform=windows)
- [Linux](https://rakazo.com/api/download?platform=linux)
- [iPhone](${IOS_APP_URL})
- [Android](${ANDROID_APP_STORE_URL})
- [Web](${APP_URL})

The apps also connect to a self-hosted server. See the [self-hosting guide](https://rakazo.com/self-hosted-ai-agent/).
`;

export const GET: APIRoute = ({ request }) =>
  markdownResponse(DOWNLOAD_MARKDOWN, request.method);
