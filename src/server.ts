import { app } from "./app.js";
import { env } from "./core/config/env.js";

app.listen(env.PORT, () => {
  console.log(`FinSight API listening on port ${env.PORT}`);
});
