import { tokenize, builtinGrade } from "../src/lib/grading/core";
const claim = "Parameters are updated in the opposite direction of the gradient: w = w - learning_rate * gradient.";
const st = "At every step you calculate the gradient of the loss with respect to each parameter, and then we move in the direction of the gradient to reduce the loss.";
for (const x of [claim, st]) console.log(tokenize(x).toks.map(t=>t.t).join(" "));
console.log(JSON.stringify(builtinGrade({ topic: "Gradient Descent", claims: [{ id: "c1", text: claim, page: 1 }, { id: "c2", text: "The learning rate controls the size of each step.", page: 1 }], chunks: [], explanation: st }).claims));
