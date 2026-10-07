// node examples/quickstart.mjs: one free image, no API key needed.
import { Tanvo } from "tanvo";

const tanvo = new Tanvo();
const image = await tanvo.generateImage({ prompt: "a paper lantern floating over a misty lake at dawn", aspect: "16:9" });
console.log(image.status, image.outputs[0]?.url);
console.log("saved to", await tanvo.download(image, "out/"));
