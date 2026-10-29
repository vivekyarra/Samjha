// Sample subject for demo mode and "use sample notes" onboarding: Intro to Machine Learning.
// Pages are realistic lecture notes; every claim paraphrases text on its cited page so grading + citations work offline.

export const DEMO_SUBJECT_NAME = "Intro to Machine Learning";
export const DEMO_FILE_NAME = "Intro_to_ML_Lecture_Notes.pdf";

/** Page texts, index 0 = page 1. */
export const DEMO_PAGES: string[] = [
  // p1 Loss functions
  `Lecture 1: Loss functions

A loss function measures how wrong a model's prediction is for a single example. The cost (or objective) is the average loss over the whole training set, and training a model means finding the parameters that make this number as small as possible.

For regression we usually use mean squared error (MSE): the average of the squared differences between the predicted value and the true value. Squaring makes every error positive and punishes large errors much more than small ones, so a single outlier can dominate MSE.

For classification we use cross-entropy loss. The model outputs a probability for each class, and cross-entropy is the negative log of the probability given to the correct class. A confident wrong answer (probability near 0 for the true class) gives a very large loss, while a confident right answer gives a loss close to 0.

The loss must be differentiable with respect to the parameters, because gradient-based training needs its slope. Accuracy is not used as a training loss: it is a step function, so its gradient is zero almost everywhere.

Key idea: the loss turns "how good is my model" into a single number that we can minimise.`,

  // p2 Gradient descent
  `Lecture 2: Gradient descent

Gradient descent is an iterative optimisation algorithm. It minimises the loss function by repeatedly adjusting the model's parameters (weights and biases) by small amounts.

The gradient is the vector of partial derivatives of the loss with respect to each parameter. It points in the direction of steepest increase of the loss. To make the loss smaller we therefore move in the opposite direction: the update rule is w_new = w_old - learning_rate * gradient. Moving with the gradient instead of against it would make the loss go up.

The size of each step is the learning rate multiplied by the gradient. Near a minimum the gradient becomes small, so the steps naturally shrink.

The algorithm stops, or converges, when the gradient is close to zero, which means we have reached a minimum. On non-convex losses such as neural networks, this can be a local minimum or a saddle point rather than the global minimum.

Batch gradient descent computes the gradient over the whole training set each step, which is accurate but slow. Stochastic and mini-batch gradient descent estimate the gradient from one example or a small batch (for example 32 examples). The estimate is noisy, but each step is far cheaper, and the noise can even help escape shallow local minima.

Analogy from class: walking down a foggy hill by always stepping in the steepest downhill direction.`,

  // p3 Learning rate
  `Lecture 3: The learning rate

The learning rate (often written as alpha or eta) is a hyperparameter that controls how big a step gradient descent takes on each update. It is chosen by us, not learned from the data.

If the learning rate is too small, training is very slow: the loss decreases, but it can take thousands of extra steps, and training may get stuck on plateaus.

If the learning rate is too large, the updates overshoot the minimum. The loss can bounce around, oscillate, or even diverge and grow to infinity (you will see NaN losses).

A common practice is a learning-rate schedule: start with a larger learning rate to make fast progress and decay it over time (step decay, exponential decay, or cosine annealing) so the final steps are small and precise.

Adaptive optimisers such as Adam and RMSProp keep a separate effective learning rate for each parameter, scaled by the history of its gradients. They are less sensitive to the initial choice, but the base learning rate still matters.

Practical tip: plot the training loss for a few learning rates on a log scale (0.1, 0.01, 0.001) and pick the largest one where the loss still goes down smoothly.`,

  // p4 Chain rule
  `Lecture 4: The chain rule

The chain rule tells us how to differentiate a composition of functions. If y = f(g(x)), then dy/dx = f'(g(x)) * g'(x): the derivative of the outer function, evaluated at the inner function, multiplied by the derivative of the inner function.

In words: when one quantity depends on a second, which depends on a third, the rates of change multiply. If z depends on y and y depends on x, then dz/dx = dz/dy * dy/dx.

Example: for y = (3x + 1)^2, let u = 3x + 1. Then dy/du = 2u and du/dx = 3, so dy/dx = 2(3x + 1) * 3 = 6(3x + 1).

When a variable affects the output through several paths, we sum the contributions from each path (the multivariable chain rule).

A neural network is a long composition of functions, one per layer. So the derivative of the loss with respect to an early weight is a product of many local derivatives, one per layer it passes through. This is exactly why the chain rule is the mathematical engine of backpropagation.

Watch out: if many of those local derivatives are smaller than 1, their product shrinks towards zero (vanishing gradients); if many are larger than 1, it can explode.`,

  // p5 Neural network basics
  `Lecture 5: Neural network basics

A neural network is made of layers of neurons: an input layer, one or more hidden layers, and an output layer. Each neuron computes a weighted sum of its inputs, adds a bias, and passes the result through an activation function: a = activation(w · x + b).

The weights and biases are the parameters of the network. They start as small random numbers and are learned during training. If all weights started at the same value, every neuron in a layer would learn the same thing, so random initialisation breaks this symmetry.

A forward pass sends the input through the network layer by layer to produce a prediction. The prediction is compared with the true label using a loss function.

Networks with at least one hidden layer and non-linear activations can approximate very complicated functions (the universal approximation theorem). Depth lets the network build features in stages: early layers detect simple patterns, later layers combine them into more abstract ones.

The number of layers and the number of neurons per layer are hyperparameters, chosen before training. More parameters mean more capacity, but also more risk of overfitting.

Training loop: forward pass, compute loss, backpropagation to get gradients, gradient descent update, repeat.`,

  // p6 Activation functions
  `Lecture 6: Activation functions

An activation function is applied to each neuron's weighted sum to introduce non-linearity. Without non-linear activations, stacking layers is pointless: a composition of linear layers is still just one linear function, no matter how deep.

Sigmoid squashes any input to a value between 0 and 1, which is useful for probabilities in binary classification. Its derivative is at most 0.25 and is almost zero for large positive or negative inputs, so deep sigmoid networks suffer from vanishing gradients.

Tanh outputs values between -1 and 1 and is zero-centred, which often trains a little faster than sigmoid, but it also saturates.

ReLU (rectified linear unit) outputs max(0, x). It is cheap to compute and does not saturate for positive inputs, so gradients flow well; it is the default choice for hidden layers. One known issue is "dying ReLU": a neuron whose input is always negative outputs zero and gets zero gradient forever. Leaky ReLU fixes this with a small slope for negative inputs.

Softmax is used on the output layer for multi-class classification. It turns a vector of scores into probabilities that are all positive and sum to 1.

Rule of thumb: ReLU in hidden layers, sigmoid for a binary output, softmax for multi-class outputs.`,

  // p7 Backpropagation
  `Lecture 7: Backpropagation

Backpropagation is the algorithm that computes the gradient of the loss with respect to every weight and bias in the network, efficiently, in one backward sweep.

First, a forward pass computes the output, and every layer's intermediate values (weighted sums and activations) are stored. The backward pass reuses these stored values, which is why training needs more memory than prediction.

Then backpropagation works backwards, from the output layer to the input layer. It starts with the derivative of the loss with respect to the output and moves one layer at a time towards the input.

At each layer it applies the chain rule: the gradient flowing in from the layer above is multiplied by the layer's local derivative (the derivative of its activation function and of its weighted sum). This gives the gradients for that layer's weights and the gradient to pass further back.

Backpropagation only computes gradients; it does not change the weights by itself. The gradients are then used by gradient descent (or an optimiser like Adam) to update the weights.

Because each intermediate derivative is computed once and reused, backpropagation costs roughly the same as two forward passes, instead of one pass per weight.

Common confusion: "backpropagation" and "gradient descent" are not the same thing. Backprop finds the slope; gradient descent takes the step.`,

  // p8 Overfitting
  `Lecture 8: Overfitting

Overfitting happens when a model learns the noise and the specific details of the training data instead of the general pattern. It memorises the training examples rather than learning something that transfers.

The signature of overfitting is a gap: low training error but high validation or test error. The model looks excellent on data it has seen and performs poorly on new data.

Overfitting is more likely when the model is very complex compared to the amount of data: many parameters, deep networks, or high-degree polynomials trained on a small dataset.

We detect it by plotting learning curves. Training loss keeps falling, but at some point the validation loss stops falling and starts to rise. That turning point is where the model starts overfitting.

The opposite problem is underfitting: the model is too simple to capture the pattern, so both training and validation error are high.

Remedies for overfitting: collect more training data, use data augmentation, use regularization (L1, L2, dropout), stop training early when validation loss starts rising (early stopping), or choose a simpler model.

Bias-variance view: an overfit model has low bias and high variance; small changes in the training set change it a lot.`,

  // p9 Regularization
  `Lecture 9: Regularization

Regularization is any technique that reduces overfitting by discouraging the model from becoming too complex, usually at the cost of slightly higher training error.

L2 regularization (weight decay) adds a penalty proportional to the sum of the squared weights to the loss: loss + lambda * sum(w^2). It pushes all weights towards small values, which gives a smoother model.

L1 regularization adds a penalty proportional to the sum of the absolute values of the weights. It tends to push many weights to exactly zero, so it produces sparse models and acts as a form of feature selection.

The strength of the penalty, lambda, is a hyperparameter. If lambda is too large the model underfits; if it is too small the penalty has no effect. It is tuned on the validation set.

Dropout randomly switches off a fraction of neurons (for example 50%) on each training step. The network cannot rely on any single neuron, so it learns more robust, redundant features. Dropout is turned off at test time.

Early stopping is also a form of regularization: we stop training when the validation loss stops improving and keep the best weights.

Remember: regularization is applied only during training; it changes what the model learns, not how predictions are made.`,

  // p10 Train/validation/test split
  `Lecture 10: Train, validation and test sets

We split the available data into three parts. A common split is 70% training, 15% validation and 15% test.

The training set is used to fit the model's parameters: the weights are learned from it with gradient descent.

The validation set is used to tune hyperparameters (learning rate, number of layers, regularization strength) and to decide when to stop training. We compare different models on it and pick the best one.

The test set is used only once, at the very end, to estimate how well the final model will perform on new, unseen data. If we look at the test set while making decisions, our estimate becomes optimistic, because information has leaked into the model choice.

Data leakage is when information from the validation or test data influences training, for example normalising features using statistics computed on the whole dataset before splitting. Always split first.

When data is scarce, k-fold cross-validation splits the training data into k parts, trains k times with a different part held out each time, and averages the results.

The split must be random (or stratified so class proportions are kept), except for time-series data, where we must split by time so we never train on the future.`,
];

export interface DemoTopicDef {
  key: string;
  name: string;
  claims: { text: string; page: number }[];
}

export const DEMO_TOPICS: DemoTopicDef[] = [
  {
    key: "loss", name: "Loss functions",
    claims: [
      { text: "A loss function measures how wrong a model's prediction is, and training means finding parameters that minimise the average loss.", page: 1 },
      { text: "Mean squared error averages the squared differences between predictions and true values, so large errors are punished much more.", page: 1 },
      { text: "Cross-entropy loss is the negative log of the probability the model gives to the correct class.", page: 1 },
      { text: "A confident wrong prediction gives a very large cross-entropy loss.", page: 1 },
      { text: "The loss must be differentiable, which is why accuracy is not used as a training loss.", page: 1 },
    ],
  },
  {
    key: "gd", name: "Gradient Descent",
    claims: [
      { text: "Gradient descent is an iterative algorithm that minimises the loss by repeatedly adjusting the model's parameters.", page: 2 },
      { text: "The gradient points in the direction of steepest increase of the loss.", page: 2 },
      { text: "Parameters are updated in the opposite direction of the gradient: w = w - learning_rate * gradient.", page: 2 },
      { text: "The step size is the learning rate multiplied by the gradient.", page: 2 },
      { text: "Gradient descent converges when the gradient is close to zero, which may be a local minimum rather than the global one.", page: 2 },
      { text: "Stochastic and mini-batch gradient descent estimate the gradient from one example or a small batch, making each step cheaper but noisier.", page: 2 },
    ],
  },
  {
    key: "lr", name: "Learning rate",
    claims: [
      { text: "The learning rate is a hyperparameter that controls how big each gradient descent step is.", page: 3 },
      { text: "A learning rate that is too small makes training very slow.", page: 3 },
      { text: "A learning rate that is too large overshoots the minimum, so the loss oscillates or diverges.", page: 3 },
      { text: "Learning-rate schedules start large and decay the learning rate over time.", page: 3 },
      { text: "Adaptive optimisers like Adam keep a separate effective learning rate for each parameter.", page: 3 },
    ],
  },
  {
    key: "chain", name: "Chain rule",
    claims: [
      { text: "The chain rule differentiates a composition: if y = f(g(x)), then dy/dx = f'(g(x)) * g'(x).", page: 4 },
      { text: "When quantities depend on each other in a chain, their rates of change multiply: dz/dx = dz/dy * dy/dx.", page: 4 },
      { text: "When a variable affects the output through several paths, the contributions from each path are added.", page: 4 },
      { text: "A neural network is a composition of layers, so the gradient for an early weight is a product of local derivatives, one per layer.", page: 4 },
      { text: "Multiplying many local derivatives smaller than 1 makes gradients vanish; many larger than 1 makes them explode.", page: 4 },
    ],
  },
  {
    key: "nn", name: "Neural network basics",
    claims: [
      { text: "A neural network has an input layer, one or more hidden layers and an output layer.", page: 5 },
      { text: "Each neuron computes a weighted sum of its inputs plus a bias and applies an activation function.", page: 5 },
      { text: "Weights and biases are the learned parameters and are initialised randomly to break symmetry.", page: 5 },
      { text: "A forward pass sends the input through the layers to produce a prediction that is compared with the label using a loss.", page: 5 },
      { text: "The number of layers and neurons are hyperparameters; more parameters mean more capacity but more risk of overfitting.", page: 5 },
    ],
  },
  {
    key: "act", name: "Activation functions",
    claims: [
      { text: "Activation functions add non-linearity; without them, stacked linear layers collapse into one linear function.", page: 6 },
      { text: "Sigmoid squashes inputs to between 0 and 1, but its small derivative causes vanishing gradients in deep networks.", page: 6 },
      { text: "ReLU outputs max(0, x), is cheap, does not saturate for positive inputs, and is the default for hidden layers.", page: 6 },
      { text: "A dying ReLU neuron always outputs zero and gets zero gradient; leaky ReLU fixes this with a small negative slope.", page: 6 },
      { text: "Softmax turns the output scores into probabilities that sum to 1 for multi-class classification.", page: 6 },
    ],
  },
  {
    key: "backprop", name: "Backpropagation",
    claims: [
      { text: "Backpropagation computes the gradient of the loss with respect to every weight and bias in the network.", page: 7 },
      { text: "A forward pass first computes and stores every layer's activations, which the backward pass reuses.", page: 7 },
      { text: "Backpropagation works backwards, from the output layer to the input layer.", page: 7 },
      { text: "At each layer it applies the chain rule, multiplying the incoming gradient by the layer's local derivative.", page: 7 },
      { text: "Backpropagation only computes gradients; gradient descent then uses them to update the weights.", page: 7 },
    ],
  },
  {
    key: "overfit", name: "Overfitting",
    claims: [
      { text: "Overfitting is when a model learns the noise and specific details of the training data instead of the general pattern.", page: 8 },
      { text: "An overfit model has low training error but high validation or test error.", page: 8 },
      { text: "Overfitting is more likely when the model is very complex compared to the amount of training data.", page: 8 },
      { text: "Overfitting shows up when validation loss starts rising while training loss keeps falling.", page: 8 },
      { text: "Remedies include more data, data augmentation, regularization, early stopping and simpler models.", page: 8 },
    ],
  },
  {
    key: "reg", name: "Regularization",
    claims: [
      { text: "Regularization reduces overfitting by discouraging the model from becoming too complex.", page: 9 },
      { text: "L2 regularization adds a penalty on the sum of squared weights, pushing weights towards small values.", page: 9 },
      { text: "L1 regularization penalises absolute weights and pushes many weights to exactly zero, giving sparse models.", page: 9 },
      { text: "The regularization strength lambda is a hyperparameter tuned on the validation set; too large causes underfitting.", page: 9 },
      { text: "Dropout randomly switches off neurons during training so the network cannot rely on any single neuron, and is turned off at test time.", page: 9 },
    ],
  },
  {
    key: "split", name: "Train/validation/test split",
    claims: [
      { text: "The training set is used to fit the model's parameters.", page: 10 },
      { text: "The validation set is used to tune hyperparameters and decide when to stop training.", page: 10 },
      { text: "The test set is used only once at the end to estimate performance on unseen data.", page: 10 },
      { text: "Data leakage happens when validation or test information influences training, so always split before preprocessing.", page: 10 },
      { text: "k-fold cross-validation trains k times with a different held-out part and averages the results.", page: 10 },
    ],
  },
];

/** [topic, dependsOn] by key. */
export const DEMO_PREREQS: [string, string][] = [
  ["backprop", "chain"],
  ["backprop", "gd"],
  ["backprop", "nn"],
  ["gd", "loss"],
  ["gd", "lr"],
  ["reg", "overfit"],
  ["overfit", "split"],
  ["act", "nn"],
  ["nn", "loss"],
];

/**
 * Deliberately imperfect explanations for the "Suggested explanation" button (spec F14).
 * Each one: exactly 1 wrong claim, 2 missing, the rest covered.
 */
export const DEMO_SUGGESTED_EXPLANATION: Record<string, string> = {
  "Gradient Descent":
    "Okay so gradient descent is basically how a model learns. It's an iterative algorithm: you keep adjusting the weights and biases a little bit at a time so that the loss function gets smaller and smaller. At every step you calculate the gradient of the loss with respect to each parameter, and then we move in the direction of the gradient to reduce the loss. How big the step is depends on the learning rate, so the step size is the learning rate times the gradient. In practice you usually don't use the whole dataset for every step, you use mini-batches, like 32 examples at a time, which makes each step much cheaper even though the gradient estimate is a bit noisy. You just keep repeating this until training is done.",
  Backpropagation:
    "Backpropagation is how a neural network figures out the gradient of the loss with respect to every weight and bias in the network. The way it works is the error is passed forward from the input layer to the output layer, one layer at a time, and each layer works out how much its weights contributed to the mistake. The important thing is that backpropagation itself doesn't actually change any weights. It just computes the gradients, and then gradient descent, or an optimiser like Adam, uses those gradients to update the weights. That's also why people mix them up, but they're two different steps: one finds the slope, the other takes the step downhill. It's much more efficient than computing every gradient separately.",
  Overfitting:
    "Overfitting is when the model basically memorises the training data, including the noise and random little details, instead of learning the general pattern that would work on new examples. You can usually tell because an overfit model does badly on the training data too, its training error goes up along with the test error, so everything just looks bad. To fix it you have a bunch of options: get more training data, use data augmentation, add regularization like L2 or dropout, use early stopping, or just pick a simpler model with fewer parameters. The whole point is that we care about how the model does on data it hasn't seen, not on the data it was trained on, so a model that memorises isn't useful.",
  "Chain rule":
    "The chain rule is for differentiating a function inside another function. If y equals f of g of x, then dy by dx is the derivative of the outer function evaluated at g of x, times the derivative of the inner function. So basically when things depend on each other in a chain, you add their rates of change together, like dz by dx equals dz by dy plus dy by dx. This matters a lot for neural networks, because a network is just a long composition of layers, so the gradient for an early weight ends up being built from the local derivatives of every layer it passes through. That's literally what backpropagation uses under the hood.",
  "Learning rate":
    "The learning rate is a hyperparameter that controls how big each step of gradient descent is. We choose it ourselves, the model doesn't learn it. If you set it too small, training becomes really slow, it takes forever to reach the bottom. If you set it too large, the model learns faster and always reaches a better minimum, so bigger is generally safer. Picking it is mostly trial and error: you try a few values like 0.1, 0.01 and 0.001 and watch what the loss does. So basically it's the knob for how aggressive the updates are.",
};

/** Fallback for topics without a hand-written suggestion: covers all but the last two claims. */
export function genericSuggestion(topicName: string, claims: string[]): string {
  const kept = claims.slice(0, Math.max(1, claims.length - 2));
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");
  return `So ${topicName} — let me try. ${kept.map((c, i) => (i === 0 ? `Basically, ${lower(c)}.` : `Also, ${lower(c)}.`)).join(" ")} I think that's the main idea.`;
}
