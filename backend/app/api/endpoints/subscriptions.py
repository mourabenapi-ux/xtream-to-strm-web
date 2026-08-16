from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from app.api import deps
from app.models.subscription import Subscription
from app.schemas import SubscriptionCreate, SubscriptionUpdate, SubscriptionResponse

router = APIRouter()

@router.get("/", response_model=List[SubscriptionResponse])
def read_subscriptions(
    db: Session = Depends(deps.get_db),
    skip: int = 0,
    limit: int = 100,
):
    subscriptions = db.query(Subscription).offset(skip).limit(limit).all()
    return subscriptions

@router.post("/", response_model=SubscriptionResponse)
def create_subscription(
    subscription: SubscriptionCreate,
    db: Session = Depends(deps.get_db),
):
    db_subscription = Subscription(**subscription.dict())
    db.add(db_subscription)
    db.commit()
    db.refresh(db_subscription)
    return db_subscription

@router.get("/{subscription_id}", response_model=SubscriptionResponse)
def read_subscription(
    subscription_id: int,
    db: Session = Depends(deps.get_db),
):
    subscription = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if subscription is None:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return subscription

@router.put("/{subscription_id}", response_model=SubscriptionResponse)
def update_subscription(
    subscription_id: int,
    subscription: SubscriptionUpdate,
    db: Session = Depends(deps.get_db),
):
    db_subscription = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if db_subscription is None:
        raise HTTPException(status_code=404, detail="Subscription not found")
    
    update_data = subscription.dict(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_subscription, key, value)
    
    db.add(db_subscription)
    db.commit()
    db.refresh(db_subscription)
    return db_subscription

@router.delete("/{subscription_id}", response_model=SubscriptionResponse)
def delete_subscription(
    subscription_id: int,
    db: Session = Depends(deps.get_db),
):
    db_subscription = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if db_subscription is None:
        raise HTTPException(status_code=404, detail="Subscription not found")
    
    db.delete(db_subscription)
    db.commit()
    return db_subscription
