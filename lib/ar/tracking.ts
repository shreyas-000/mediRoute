export type XRPosition = {
  x: number   // metres, floor plan coordinate space
  y: number
  floor: number
}

export type XRTracker = {
  // Call when a QR anchor establishes absolute position
  recalibrate: (worldPos: XRPosition, currentPose: XRViewerPose) => void
  // Call every XR frame — returns current estimated world position
  getWorldPosition: (currentPose: XRViewerPose) => XRPosition
  // Heading in degrees (0 = +X axis of floor plan)
  getHeading: (currentPose: XRViewerPose) => number
}

export function createXRTracker(): XRTracker {
  let worldOrigin: XRPosition = { x: 0, y: 0, floor: 1 }
  // XR position at the time of last calibration
  let poseOrigin: { x: number; y: number; z: number } | null = null

  function getPoseTranslation(pose: XRViewerPose) {
    const m = pose.transform.matrix
    return { x: m[12], y: m[13], z: m[14] }
  }

  return {
    recalibrate(worldPos, currentPose) {
      worldOrigin = worldPos
      poseOrigin = getPoseTranslation(currentPose)
    },

    getWorldPosition(currentPose) {
      if (!poseOrigin) return worldOrigin
      const p = getPoseTranslation(currentPose)
      // XR space: X = right, Z = forward (into screen/ahead of camera), Y = up
      // Floor plan space: X = right, Y = down the corridor
      // Map XR delta-X → floor plan delta-X, XR delta-Z → floor plan delta-Y
      const dx = p.x - poseOrigin.x
      const dy = p.z - poseOrigin.z   // forward movement in XR = Y in our 2D plan
      return {
        x: worldOrigin.x + dx,
        y: worldOrigin.y + dy,
        floor: worldOrigin.floor,
      }
    },

    getHeading(currentPose) {
      // Extract heading from the rotation component of the XR transform
      // XR quaternion → yaw angle
      const q = currentPose.transform.orientation
      const yaw = Math.atan2(
        2 * (q.w * q.y + q.x * q.z),
        1 - 2 * (q.y * q.y + q.z * q.z)
      )
      return yaw * (180 / Math.PI)
    },
  }
}
