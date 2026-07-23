export type XRPosition = {
  x: number   // metres, floor plan coordinate space
  y: number
  floor: number
}

export type XRTracker = {
  // Call when a QR anchor establishes absolute position
  recalibrate: (worldPos: XRPosition, currentPose: XRViewerPose, mapAngleRad?: number) => void
  // Call every XR frame — returns current estimated world position
  getWorldPosition: (currentPose: XRViewerPose) => XRPosition
  // Heading in degrees (0 = +X axis of floor plan)
  getHeading: (currentPose: XRViewerPose) => number
}

export function createXRTracker(): XRTracker {
  let worldOrigin: XRPosition = { x: 0, y: 0, floor: 1 }
  // XR position at the time of last calibration
  let poseOrigin: { x: number; y: number; z: number } | null = null
  let trackingTheta = 0 // rotation to align XR space with Map space

  function getPoseTranslation(pose: XRViewerPose) {
    const m = pose.transform.matrix
    return { x: m[12], y: m[13], z: m[14] }
  }

  return {
    recalibrate(worldPos, currentPose, mapAngleRad = -Math.PI / 2) {
      worldOrigin = worldPos
      poseOrigin = getPoseTranslation(currentPose)
      // XR -Z (forward) has an angle of -PI/2. We rotate XR coordinates to match the map angle.
      trackingTheta = mapAngleRad + Math.PI / 2
    },

    getWorldPosition(currentPose) {
      if (!poseOrigin) return worldOrigin
      const p = getPoseTranslation(currentPose)
      
      const dx_xr = p.x - poseOrigin.x
      const dz_xr = p.z - poseOrigin.z   
      
      // Rotate the XR movement vector to align with the 2D floor plan
      const mapDx = dx_xr * Math.cos(trackingTheta) - dz_xr * Math.sin(trackingTheta)
      const mapDy = dx_xr * Math.sin(trackingTheta) + dz_xr * Math.cos(trackingTheta)
      
      return {
        x: worldOrigin.x + mapDx,
        y: worldOrigin.y + mapDy,
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
