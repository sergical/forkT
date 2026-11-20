import * as Layer from "effect/Layer";
import * as Coordinator from "./ForkCoordinatorService.ts";
import * as Store from "./ForkCoordinatorStore.ts";
import * as Memory from "./ForkMemoryService.ts";
import * as Dream from "./ForkDreamService.ts";

const coordinator = Coordinator.layer.pipe(Layer.provideMerge(Store.layer));
export const layer = Dream.layer.pipe(Layer.provideMerge(Layer.merge(coordinator, Memory.layer)));
