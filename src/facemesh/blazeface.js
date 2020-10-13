const tf = require('@tensorflow/tfjs');

const ANCHORS_CONFIG = {
  strides: [8, 16],
  anchors: [2, 6],
};

const NUM_LANDMARKS = 6;
function generateAnchors(width, height, outputSpec) {
  const anchors = [];
  for (let i = 0; i < outputSpec.strides.length; i++) {
    const stride = outputSpec.strides[i];
    const gridRows = Math.floor((height + stride - 1) / stride);
    const gridCols = Math.floor((width + stride - 1) / stride);
    const anchorsNum = outputSpec.anchors[i];
    for (let gridY = 0; gridY < gridRows; gridY++) {
      const anchorY = stride * (gridY + 0.5);
      for (let gridX = 0; gridX < gridCols; gridX++) {
        const anchorX = stride * (gridX + 0.5);
        for (let n = 0; n < anchorsNum; n++) {
          anchors.push([anchorX, anchorY]);
        }
      }
    }
  }
  return anchors;
}

const disposeBox = (box) => {
  box.startEndTensor.dispose();
  box.startPoint.dispose();
  box.endPoint.dispose();
};

const createBox = (startEndTensor) => ({
  startEndTensor,
  startPoint: tf.slice(startEndTensor, [0, 0], [-1, 2]),
  endPoint: tf.slice(startEndTensor, [0, 2], [-1, 2]),
});

const scaleBox = (box, factors) => {
  const starts = tf.mul(box.startPoint, factors);
  const ends = tf.mul(box.endPoint, factors);
  const newCoordinates = tf.concat2d([starts, ends], 1);
  return createBox(newCoordinates);
};

function decodeBounds(boxOutputs, anchors, inputSize) {
  const boxStarts = tf.slice(boxOutputs, [0, 1], [-1, 2]);
  const centers = tf.add(boxStarts, anchors);
  const boxSizes = tf.slice(boxOutputs, [0, 3], [-1, 2]);
  const boxSizesNormalized = tf.div(boxSizes, inputSize);
  const centersNormalized = tf.div(centers, inputSize);
  const halfBoxSize = tf.div(boxSizesNormalized, 2);
  const starts = tf.sub(centersNormalized, halfBoxSize);
  const ends = tf.add(centersNormalized, halfBoxSize);
  const startNormalized = tf.mul(starts, inputSize);
  const endNormalized = tf.mul(ends, inputSize);
  const concatAxis = 1;
  return tf.concat2d([startNormalized, endNormalized], concatAxis);
}

function scaleBoxFromPrediction(face, scaleFactor) {
  return tf.tidy(() => {
    const box = face['box'] ? face['box'] : face;
    return scaleBox(box, scaleFactor).startEndTensor.squeeze();
  });
}

class BlazeFaceModel {
  constructor(model, config) {
    this.blazeFaceModel = model;
    this.width = config.detector.inputSize;
    this.height = config.detector.inputSize;
    this.maxFaces = config.detector.maxFaces;
    this.anchorsData = generateAnchors(config.detector.inputSize, config.detector.inputSize, ANCHORS_CONFIG);
    this.anchors = tf.tensor2d(this.anchorsData);
    this.inputSizeData = [config.detector.inputSize, config.detector.inputSize];
    this.inputSize = tf.tensor1d([config.detector.inputSize, config.detector.inputSize]);
    this.iouThreshold = config.detector.iouThreshold;
    this.scoreThreshold = config.detector.scoreThreshold;
  }

  async getBoundingBoxes(inputImage) {
    const [detectedOutputs, boxes, scores] = tf.tidy(() => {
      const resizedImage = inputImage.resizeBilinear([this.width, this.height]);
      const normalizedImage = tf.mul(tf.sub(resizedImage.div(255), 0.5), 2);
      const batchedPrediction = this.blazeFaceModel.predict(normalizedImage);
      const prediction = batchedPrediction.squeeze();
      const decodedBounds = decodeBounds(prediction, this.anchors, this.inputSize);
      const logits = tf.slice(prediction, [0, 0], [-1, 1]);
      const scoresOut = tf.sigmoid(logits).squeeze();
      return [prediction, decodedBounds, scoresOut];
    });

    const boxIndicesTensor = await tf.image.nonMaxSuppressionAsync(boxes, scores, this.maxFaces, this.iouThreshold, this.scoreThreshold);
    const boxIndices = await boxIndicesTensor.array();
    boxIndicesTensor.dispose();
    let boundingBoxes = boxIndices.map((boxIndex) => tf.slice(boxes, [boxIndex, 0], [1, -1]));
    boundingBoxes = await Promise.all(boundingBoxes.map(async (boundingBox) => {
      const vals = await boundingBox.array();
      boundingBox.dispose();
      return vals;
    }));
    const annotatedBoxes = [];
    for (let i = 0; i < boundingBoxes.length; i++) {
      const boundingBox = boundingBoxes[i];
      const annotatedBox = tf.tidy(() => {
        const box = createBox(boundingBox);
        const boxIndex = boxIndices[i];
        const anchor = this.anchorsData[boxIndex];
        const landmarks = tf.slice(detectedOutputs, [boxIndex, NUM_LANDMARKS - 1], [1, -1])
          .squeeze()
          .reshape([NUM_LANDMARKS, -1]);
        const probability = tf.slice(scores, [boxIndex], [1]);
        return { box, landmarks, probability, anchor };
      });
      annotatedBoxes.push(annotatedBox);
    }
    boxes.dispose();
    scores.dispose();
    detectedOutputs.dispose();
    return {
      boxes: annotatedBoxes,
      scaleFactor: [inputImage.shape[2] / this.inputSizeData[0], inputImage.shape[1] / this.inputSizeData[1]],
    };
  }

  async estimateFaces(input, returnTensors = false, annotateBoxes = true) {
    const image = tf.tidy(() => {
      if (!(input instanceof tf.Tensor)) {
        input = tf.browser.fromPixels(input);
      }
      return input.toFloat().expandDims(0);
    });
    const { boxes, scaleFactor } = await this.getBoundingBoxes(image);
    image.dispose();
    if (returnTensors) {
      return boxes.map((face) => {
        const scaledBox = scaleBoxFromPrediction(face, scaleFactor);
        const normalizedFace = {
          topLeft: scaledBox.slice([0], [2]),
          bottomRight: scaledBox.slice([2], [2]),
        };
        if (annotateBoxes) {
          const { landmarks, probability, anchor } = face;
          const normalizedLandmarks = landmarks.add(anchor).mul(scaleFactor);
          normalizedFace.landmarks = normalizedLandmarks;
          normalizedFace.probability = probability;
        }
        return normalizedFace;
      });
    }
    return Promise.all(boxes.map(async (face) => {
      const scaledBox = scaleBoxFromPrediction(face, scaleFactor);
      let normalizedFace;
      if (!annotateBoxes) {
        const boxData = await scaledBox.array();
        normalizedFace = {
          topLeft: boxData.slice(0, 2),
          bottomRight: boxData.slice(2),
        };
      } else {
        const [landmarkData, boxData, probabilityData] = await Promise.all([face.landmarks, scaledBox, face.probability].map(async (d) => d.array()));
        const anchor = face.anchor;
        const [scaleFactorX, scaleFactorY] = scaleFactor;
        const scaledLandmarks = landmarkData
          .map((landmark) => ([
            (landmark[0] + anchor[0]) * scaleFactorX,
            (landmark[1] + anchor[1]) * scaleFactorY,
          ]));
        normalizedFace = {
          topLeft: boxData.slice(0, 2),
          bottomRight: boxData.slice(2),
          landmarks: scaledLandmarks,
          probability: probabilityData,
        };
        disposeBox(face.box);
        face.landmarks.dispose();
        face.probability.dispose();
      }
      scaledBox.dispose();
      return normalizedFace;
    }));
  }
}

async function load(config) {
  const blazeface = await tf.loadGraphModel(config.detector.modelPath, { fromTFHub: config.detector.modelPath.includes('tfhub.dev') });
  const model = new BlazeFaceModel(blazeface, config);
  return model;
}

exports.load = load;
exports.BlazeFaceModel = BlazeFaceModel;
exports.disposeBox = disposeBox;